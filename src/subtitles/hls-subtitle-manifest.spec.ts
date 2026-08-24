import {
  FALLBACK_DURATION_SECONDS,
  buildSubtitleMediaPlaylist,
  firstSegmentUri,
  firstVariantUri,
  rewriteMasterPlaylist,
  totalDurationFromMediaPlaylist,
  type SubtitleRendition,
} from './hls-subtitle-manifest';

/**
 * Byte-for-byte the master ffmpeg's buildMasterPlaylist() writes today
 * (and the shape the externally pre-transcoded bundles ship), so the
 * no-op and idempotence assertions below are about the real file, not a
 * convenient fiction.
 */
const FFMPEG_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720',
  '720p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1528000,RESOLUTION=854x480',
  '480p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=928000,RESOLUTION=640x360',
  '360p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240',
  '240p/index.m3u8',
].join('\n') + '\n';

const ENGLISH: SubtitleRendition = {
  id: 'cc0ce210-d64a-4a83-ab24-33369b711e43',
  label: 'English',
  language: 'en',
  isDefault: true,
};

const BURMESE: SubtitleRendition = {
  id: '11111111-2222-3333-4444-555555555555',
  label: 'Myanmar',
  language: 'my',
  isDefault: false,
};

const streamInfLines = (master: string) =>
  master.split('\n').filter((line) => line.startsWith('#EXT-X-STREAM-INF:'));

const mediaLines = (master: string) =>
  master.split('\n').filter((line) => line.startsWith('#EXT-X-MEDIA:'));

describe('rewriteMasterPlaylist', () => {
  describe('no-op safety', () => {
    it('returns a subtitle-free master byte-identical when there are no subtitles', () => {
      expect(rewriteMasterPlaylist(FFMPEG_MASTER, [])).toBe(FFMPEG_MASTER);
    });

    it('does not even re-serialise it — a CRLF master with no subtitles is untouched', () => {
      const crlf = FFMPEG_MASTER.replace(/\n/g, '\r\n');

      expect(rewriteMasterPlaylist(crlf, [])).toBe(crlf);
    });

    it('re-emits a CRLF master with CRLF — the bundle flow authors those', () => {
      // Only reachable for a master authored elsewhere: processing.service's
      // buildMasterPlaylist joins with LF. Normalising on the way in but not
      // on the way out would rewrite the whole file on its first publish and
      // break the "delete restores the original" guarantee below.
      const crlf = FFMPEG_MASTER.replace(/\n/g, '\r\n');

      const published = rewriteMasterPlaylist(crlf, [ENGLISH]);

      expect(published).toContain('\r\n');
      expect(published.split('\r\n').filter((line) => line.includes('\n'))).toEqual([]);
      expect(rewriteMasterPlaylist(published, [])).toBe(crlf);
    });

    it('leaves a master with no trailing newline exactly as it found it', () => {
      const noTrailing = FFMPEG_MASTER.trimEnd();

      expect(rewriteMasterPlaylist(noTrailing, [])).toBe(noTrailing);
    });
  });

  describe('injecting the subtitle group', () => {
    it('adds exactly one EXT-X-MEDIA line per subtitle', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH, BURMESE]);

      expect(mediaLines(master)).toHaveLength(2);
    });

    it('emits every required attribute, with the rendition URI relative to the master', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]);

      expect(mediaLines(master)[0]).toBe(
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",' +
          'LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,' +
          `URI="subs/${ENGLISH.id}.m3u8"`,
      );
    });

    it('appends SUBTITLES="subs" to every variant', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]);

      const variants = streamInfLines(master);
      expect(variants).toHaveLength(4);
      for (const variant of variants) {
        expect(variant.endsWith(',SUBTITLES="subs"')).toBe(true);
      }
    });

    it('declares the group before the variants that reference it', () => {
      const lines = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]).split('\n');

      expect(lines.findIndex((l) => l.startsWith('#EXT-X-MEDIA:'))).toBeLessThan(
        lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:')),
      );
    });

    it('preserves the variant list and its URIs untouched', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH, BURMESE]);

      for (const rendition of ['720p', '480p', '360p', '240p']) {
        expect(master).toContain(`${rendition}/index.m3u8`);
      }
      expect(master).toContain('BANDWIDTH=2928000,RESOLUTION=1280x720');
    });

    it('marks at most one track DEFAULT=YES even when two rows claim it', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [
        { ...ENGLISH, isDefault: true },
        { ...BURMESE, isDefault: true },
      ]);

      expect(master.match(/DEFAULT=YES/g)).toHaveLength(1);
      expect(master.match(/DEFAULT=NO/g)).toHaveLength(1);
    });

    it('marks nothing DEFAULT=YES when no row is the default', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [
        { ...ENGLISH, isDefault: false },
      ]);

      expect(master).not.toContain('DEFAULT=YES');
    });

    it('strips double quotes out of a label so the attribute list still parses', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [
        { ...ENGLISH, label: 'En"glish' },
      ]);

      expect(mediaLines(master)[0]).toContain('NAME="English"');
    });

    it('de-duplicates NAME — RFC 8216 forbids two identical ones in a group', () => {
      // Nothing stops an admin labelling two tracks of one title "English":
      // the API bounds the label's length, not its uniqueness. Duplicates
      // make the master invalid and give the viewer two menu rows they cannot
      // tell apart.
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [
        ENGLISH,
        { ...BURMESE, label: 'English' },
      ]);

      const names = mediaLines(master).map(
        (line) => /NAME="([^"]*)"/.exec(line)?.[1],
      );
      expect(names).toEqual(['English', 'English (2)']);
      expect(new Set(names).size).toBe(names.length);
    });

    it('falls back to the language when a label sanitises away to nothing', () => {
      const master = rewriteMasterPlaylist(FFMPEG_MASTER, [
        { ...ENGLISH, label: '""' },
      ]);

      expect(mediaLines(master)[0]).toContain('NAME="en"');
    });
  });

  describe('idempotence', () => {
    it('leaves the master byte-identical when published twice', () => {
      const once = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH, BURMESE]);
      const twice = rewriteMasterPlaylist(once, [ENGLISH, BURMESE]);

      expect(twice).toBe(once);
    });

    it('still holds on a third run', () => {
      const once = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]);
      const thrice = rewriteMasterPlaylist(
        rewriteMasterPlaylist(once, [ENGLISH]),
        [ENGLISH],
      );

      expect(thrice).toBe(once);
    });

    it('never duplicates the SUBTITLES attribute on a variant', () => {
      const twice = rewriteMasterPlaylist(
        rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]),
        [ENGLISH],
      );

      for (const variant of streamInfLines(twice)) {
        expect(variant.match(/SUBTITLES=/g)).toHaveLength(1);
      }
    });

    it('replaces the previous block rather than appending when a track is renamed', () => {
      const before = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]);
      const after = rewriteMasterPlaylist(before, [
        { ...ENGLISH, label: 'English (CC)' },
      ]);

      expect(mediaLines(after)).toHaveLength(1);
      expect(after).toContain('NAME="English (CC)"');
      expect(after).not.toContain('NAME="English"');
    });
  });

  describe('removal', () => {
    it('restores the original master exactly when the last subtitle is deleted', () => {
      const withSubs = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH]);

      expect(rewriteMasterPlaylist(withSubs, [])).toBe(FFMPEG_MASTER);
    });

    it('drops only the removed track when one of two is deleted', () => {
      const withBoth = rewriteMasterPlaylist(FFMPEG_MASTER, [ENGLISH, BURMESE]);

      const withOne = rewriteMasterPlaylist(withBoth, [ENGLISH]);

      expect(mediaLines(withOne)).toHaveLength(1);
      expect(withOne).toContain('NAME="English"');
      expect(streamInfLines(withOne).every((l) => l.includes('SUBTITLES="subs"'))).toBe(true);
    });
  });

  describe('foreign playlists', () => {
    it('leaves a non-subtitle EXT-X-MEDIA group (e.g. audio) alone', () => {
      const withAudio =
        '#EXTM3U\n#EXT-X-VERSION:3\n' +
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="aud/en.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="aud"\n720p/index.m3u8\n';

      const master = rewriteMasterPlaylist(withAudio, [ENGLISH]);

      expect(master).toContain('TYPE=AUDIO,GROUP-ID="aud"');
      expect(master).toContain('AUDIO="aud",SUBTITLES="subs"');
      expect(rewriteMasterPlaylist(master, [ENGLISH])).toBe(master);
    });

    it('replaces a foreign subtitle group rather than stacking on top of it', () => {
      const foreign =
        '#EXTM3U\n#EXT-X-VERSION:3\n' +
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Old",LANGUAGE="en",URI="text/old.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=100,SUBTITLES="text"\n720p/index.m3u8\n';

      const master = rewriteMasterPlaylist(foreign, [ENGLISH]);

      expect(mediaLines(master)).toHaveLength(1);
      expect(master).not.toContain('GROUP-ID="text"');
      expect(streamInfLines(master)[0]).toBe(
        '#EXT-X-STREAM-INF:BANDWIDTH=100,SUBTITLES="subs"',
      );
    });

    it('removes a foreign subtitle group when there is nothing to replace it with', () => {
      const foreign =
        '#EXTM3U\n' +
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Old",URI="text/old.m3u8"\n' +
        '#EXT-X-STREAM-INF:SUBTITLES="text",BANDWIDTH=100\n720p/index.m3u8\n';

      expect(rewriteMasterPlaylist(foreign, [])).toBe(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n720p/index.m3u8\n',
      );
    });
  });
});

describe('buildSubtitleMediaPlaylist', () => {
  it('wraps the WebVTT file as a single VOD segment', () => {
    expect(buildSubtitleMediaPlaylist('sub-1', 372.5)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:373',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:372.500,',
        'sub-1.vtt',
        '#EXT-X-ENDLIST',
      ].join('\n') + '\n',
    );
  });

  it('falls back to a deliberately over-long segment when the duration is unknown', () => {
    const playlist = buildSubtitleMediaPlaylist('sub-1', 0);

    expect(playlist).toContain(
      `#EXT-X-TARGETDURATION:${FALLBACK_DURATION_SECONDS}`,
    );
  });
});

describe('media timeline recovery', () => {
  it('finds the first variant URI in a master', () => {
    expect(firstVariantUri(FFMPEG_MASTER)).toBe('720p/index.m3u8');
  });

  it('returns null for a master with no variants at all', () => {
    expect(firstVariantUri('#EXTM3U\n#EXT-X-VERSION:3\n')).toBeNull();
  });

  it('sums a variant playlist EXTINFs — the duration bundles never recorded', () => {
    const variant =
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' +
      '#EXTINF:6.000,\nsegment_000.ts\n' +
      '#EXTINF:6.000,\nsegment_001.ts\n' +
      '#EXTINF:2.250,\nsegment_002.ts\n#EXT-X-ENDLIST\n';

    expect(totalDurationFromMediaPlaylist(variant)).toBeCloseTo(14.25);
  });

  it('returns null when a playlist declares no EXTINF', () => {
    expect(totalDurationFromMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
  });

  it('finds the first segment URI — the one probed for the initial PTS', () => {
    const variant =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXTINF:6.000,\nsegment_000.ts\n' +
      '#EXTINF:6.000,\nsegment_001.ts\n#EXT-X-ENDLIST\n';

    expect(firstSegmentUri(variant)).toBe('segment_000.ts');
  });

  it('returns null for a playlist that lists no segments', () => {
    expect(firstSegmentUri('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
  });
});
