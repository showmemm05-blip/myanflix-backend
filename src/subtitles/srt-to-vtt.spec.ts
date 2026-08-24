import {
  hlsTimestampMap,
  isWebVtt,
  normalizeSubtitleText,
  srtToVtt,
  withHlsTimestampMap,
} from './srt-to-vtt';

/**
 * The reason subtitles rendered nothing: the one live track is SRT, and no
 * player on either client speaks SRT. Everything below is the textual
 * contract that turns it into something they do speak.
 */
describe('srtToVtt', () => {
  const SRT = [
    '1',
    '00:00:01,234 --> 00:00:03,456',
    'Hello there.',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,500',
    'General Kenobi.',
    'Second line.',
    '',
  ].join('\n');

  it('prepends the WEBVTT signature followed by a blank line', () => {
    const vtt = srtToVtt(SRT);

    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('converts comma decimal separators in timestamps to dots', () => {
    const vtt = srtToVtt(SRT);

    expect(vtt).toContain('00:00:01.234 --> 00:00:03.456');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.500');
    expect(vtt).not.toContain(',234');
  });

  it('drops the numeric cue counters', () => {
    const vtt = srtToVtt(SRT);

    expect(vtt.split('\n')).not.toContain('1');
    expect(vtt.split('\n')).not.toContain('2');
  });

  it('keeps a cue whose visible text is itself just a number', () => {
    const numeric = ['7', '00:00:01,000 --> 00:00:02,000', '42', ''].join('\n');

    expect(srtToVtt(numeric)).toContain('00:00:01.000 --> 00:00:02.000\n42');
  });

  it('preserves multi-line cue text', () => {
    expect(srtToVtt(SRT)).toContain('General Kenobi.\nSecond line.');
  });

  it('normalises CRLF line endings to LF', () => {
    const crlf = SRT.replace(/\n/g, '\r\n');

    const vtt = srtToVtt(crlf);

    expect(vtt).not.toContain('\r');
    expect(vtt).toContain('00:00:01.234 --> 00:00:03.456');
  });

  it('strips a UTF-8 BOM so the WEBVTT signature is actually first', () => {
    const vtt = srtToVtt(`\uFEFF${SRT}`);

    expect(vtt.charCodeAt(0)).toBe('W'.charCodeAt(0));
    expect(vtt).not.toContain('\uFEFF');
  });

  it('pads unpadded hours and short millisecond fields to WebVTT widths', () => {
    const sloppy = ['1', '0:00:01,5 --> 0:00:02,25', 'Hi', ''].join('\n');

    expect(srtToVtt(sloppy)).toContain('00:00:01.500 --> 00:00:02.250');
  });

  it('preserves cue settings that follow the timestamps', () => {
    const withSettings = [
      '1',
      '00:00:01,000 --> 00:00:02,000 line:90% align:middle',
      'Hi',
      '',
    ].join('\n');

    expect(srtToVtt(withSettings)).toContain(
      '00:00:01.000 --> 00:00:02.000 line:90% align:middle',
    );
  });

  it('leaves an already-WebVTT file untouched', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n';

    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it('is idempotent — converting its own output changes nothing', () => {
    const once = srtToVtt(SRT);

    expect(srtToVtt(once)).toBe(once);
  });

  it('drops a trailing orphan block with no timing line', () => {
    const truncated = `${SRT}\n3\n`;

    const vtt = srtToVtt(truncated);

    expect(vtt.trimEnd().endsWith('Second line.')).toBe(true);
  });
});

describe('hlsTimestampMap', () => {
  // The map anchors LOCAL 0 to a PTS, and every player shifts cues by
  // (MPEGTS - real initial PTS) / 90000. So the ONLY value that leaves the
  // cues alone is the presentation's own initial PTS — which for this stack's
  // ffmpeg-muxed renditions is ~129900 (its default mux delay), never the
  // conventional 900000, which would push every cue 8.6s late.
  it('emits the initial PTS it is given, not a fixed constant', () => {
    expect(hlsTimestampMap(129910)).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:129910,LOCAL:00:00:00.000',
    );
    expect(hlsTimestampMap(132000)).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:132000,LOCAL:00:00:00.000',
    );
  });

  it('falls back to MPEGTS:0 for a timeline that starts at zero or is unknown', () => {
    const zero = 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000';

    expect(hlsTimestampMap(0)).toBe(zero);
    expect(hlsTimestampMap(-1)).toBe(zero);
    expect(hlsTimestampMap(Number.NaN)).toBe(zero);
  });

  it('rounds — MPEGTS is an integer tick count', () => {
    expect(hlsTimestampMap(129909.6)).toBe(
      'X-TIMESTAMP-MAP=MPEGTS:129910,LOCAL:00:00:00.000',
    );
  });
});

describe('withHlsTimestampMap', () => {
  it('puts X-TIMESTAMP-MAP directly after the WEBVTT line', () => {
    const vtt = withHlsTimestampMap('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 129910);

    expect(vtt.split('\n').slice(0, 2)).toEqual(['WEBVTT', hlsTimestampMap(129910)]);
  });

  it('is idempotent — a file that already carries one is unchanged', () => {
    const once = withHlsTimestampMap(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), 129910);

    expect(withHlsTimestampMap(once, 129910)).toBe(once);
    expect(once.match(/X-TIMESTAMP-MAP/g)).toHaveLength(1);
  });

  it('adds the signature too when handed a headerless file', () => {
    const vtt = withHlsTimestampMap('00:00:01.000 --> 00:00:02.000\nHi\n', 132000);

    expect(vtt.split('\n').slice(0, 2)).toEqual(['WEBVTT', hlsTimestampMap(132000)]);
  });
});

describe('normalizeSubtitleText / isWebVtt', () => {
  it('recognises a WEBVTT signature behind a BOM', () => {
    expect(isWebVtt('\uFEFFWEBVTT\n\n')).toBe(true);
  });

  it('does not mistake a cue that merely mentions WEBVTT for a header', () => {
    expect(isWebVtt('WEBVTTish\n')).toBe(false);
  });

  it('collapses lone CR line endings as well as CRLF', () => {
    expect(normalizeSubtitleText('a\rb\r\nc')).toBe('a\nb\nc');
  });
});
