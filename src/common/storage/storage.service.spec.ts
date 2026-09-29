import type { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { scopeForKey } from './stream-signature';

const MOVIE_ID = 'f41b5f3d-cadf-40ab-b789-4192ee772a5e';
const SUBTITLE_ID = '0d9d3b1e-6c1f-4f6e-9a0b-2b7f1c8e5d21';

/**
 * The HLS key builders are the one place the "which folder is the package
 * in" decision is spelled out, and two flows depend on them agreeing:
 * a first upload packages in videos/<id>/hls/ itself, a video REPLACE one
 * folder deeper in hls/v-<tag>/ (see the class comment for why the cache
 * servers force that), and the subtitle renditions must land beside
 * whichever master is live.
 */
describe('StorageService — HLS package keys', () => {
  const storage = new StorageService({
    get: () => '/storage',
  } as unknown as ConfigService);

  describe('without a version tag (first upload: transcode, finalize, seed)', () => {
    it('packages directly in the title’s hls/ folder — the layout every existing title has', () => {
      expect(storage.hlsPackagePrefix(MOVIE_ID)).toBe(`videos/${MOVIE_ID}/hls`);
      expect(storage.hlsMasterKey(MOVIE_ID)).toBe(
        `videos/${MOVIE_ID}/hls/master.m3u8`,
      );
      expect(storage.hlsRenditionKeyPrefix(MOVIE_ID, '720p')).toBe(
        `videos/${MOVIE_ID}/hls/720p`,
      );
    });
  });

  describe('with a version tag (a video replace)', () => {
    it('packages one folder deeper, in hls/v-<tag>/, with the same shape inside', () => {
      expect(storage.hlsPackagePrefix(MOVIE_ID, 'abc123')).toBe(
        `videos/${MOVIE_ID}/hls/v-abc123`,
      );
      expect(storage.hlsMasterKey(MOVIE_ID, 'abc123')).toBe(
        `videos/${MOVIE_ID}/hls/v-abc123/master.m3u8`,
      );
      expect(storage.hlsRenditionKeyPrefix(MOVIE_ID, '720p', 'abc123')).toBe(
        `videos/${MOVIE_ID}/hls/v-abc123/720p`,
      );
    });

    it('never reuses an un-versioned key — the whole point, given the cache servers hold those for 7 days', () => {
      const unversioned = [
        storage.hlsMasterKey(MOVIE_ID),
        `${storage.hlsRenditionKeyPrefix(MOVIE_ID, '720p')}/segment_000.ts`,
      ];
      const versioned = [
        storage.hlsMasterKey(MOVIE_ID, 'abc123'),
        `${storage.hlsRenditionKeyPrefix(MOVIE_ID, '720p', 'abc123')}/segment_000.ts`,
      ];
      for (const key of versioned) expect(unversioned).not.toContain(key);
    });

    it('stays inside the title’s videoKeyPrefix, so a movie delete and the replace stale-sweep still reach it', () => {
      expect(
        storage
          .hlsMasterKey(MOVIE_ID, 'abc123')
          .startsWith(`${storage.videoKeyPrefix(MOVIE_ID)}/hls/`),
      ).toBe(true);
    });
  });

  describe('subtitle rendition keys — derived from the LIVE master, not the movie id', () => {
    // master.m3u8 names a rendition as `subs/<id>.m3u8`, a RELATIVE URI the
    // player resolves against the master's own folder; so the only correct
    // place for the objects is a subs/ folder beside whichever master the
    // Video row currently points at.
    it('sit in hls/subs/ beside an un-versioned master — unchanged for every existing title', () => {
      const master = storage.hlsMasterKey(MOVIE_ID);
      expect(storage.hlsSubtitleKeyPrefix(master)).toBe(
        `videos/${MOVIE_ID}/hls/subs`,
      );
      expect(storage.hlsSubtitleVttKey(master, SUBTITLE_ID)).toBe(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.vtt`,
      );
      expect(storage.hlsSubtitlePlaylistKey(master, SUBTITLE_ID)).toBe(
        `videos/${MOVIE_ID}/hls/subs/${SUBTITLE_ID}.m3u8`,
      );
    });

    it('follow a versioned master into hls/v-<tag>/subs/', () => {
      const master = storage.hlsMasterKey(MOVIE_ID, 'abc123');
      expect(storage.hlsSubtitleVttKey(master, SUBTITLE_ID)).toBe(
        `videos/${MOVIE_ID}/hls/v-abc123/subs/${SUBTITLE_ID}.vtt`,
      );
      expect(storage.hlsSubtitlePlaylistKey(master, SUBTITLE_ID)).toBe(
        `videos/${MOVIE_ID}/hls/v-abc123/subs/${SUBTITLE_ID}.m3u8`,
      );
    });
  });
});

/**
 * H-23: a chapter whose PDF is replaced converts into a FRESH pages/v-<tag>/
 * folder, for the same reason a video replace does — the cache server keeps
 * every object 7 days by its path, so new bytes under an old key would be
 * served as the old page. The folder must stay inside the chapter's signed
 * `pages` scope, and the whole pages/ prefix is what a replace clears.
 */
describe('StorageService — book page keys', () => {
  const storage = new StorageService({
    get: () => '/storage',
  } as unknown as ConfigService);
  const BOOK_ID = '6d0f2c1a-3b4e-4c5d-8e9f-0a1b2c3d4e5f';
  const EDITION_ID = '7e1a3d2b-4c5f-4d6e-9f0a-1b2c3d4e5f60';
  const CHAPTER_ID = '8f2b4e3c-5d6a-4e7f-a0b1-2c3d4e5f6071';
  const CHAPTER = `books/${BOOK_ID}/${EDITION_ID}/${CHAPTER_ID}`;

  it('the pages prefix is the chapter’s own pages/ folder, with its trailing slash', () => {
    expect(storage.bookPagesPrefix(BOOK_ID, EDITION_ID, CHAPTER_ID)).toBe(
      `${CHAPTER}/pages/`,
    );
  });

  it('writes a page into pages/v-<tag>/, keeping the zero-padding rule', () => {
    expect(
      storage.bookPageKey(BOOK_ID, EDITION_ID, CHAPTER_ID, 7, 120, 'abc123'),
    ).toBe(`${CHAPTER}/pages/v-abc123/page-007.webp`);
    expect(
      storage.bookPageKey(BOOK_ID, EDITION_ID, CHAPTER_ID, 7, 1200, 'abc123'),
    ).toBe(`${CHAPTER}/pages/v-abc123/page-0007.webp`);
  });

  it('a different source tag never reuses a key', () => {
    expect(
      storage.bookPageKey(BOOK_ID, EDITION_ID, CHAPTER_ID, 1, 10, 'aaa'),
    ).not.toBe(
      storage.bookPageKey(BOOK_ID, EDITION_ID, CHAPTER_ID, 1, 10, 'bbb'),
    );
  });

  it('stays under the pages prefix and inside the one signed scope per chapter', () => {
    const key = storage.bookPageKey(
      BOOK_ID,
      EDITION_ID,
      CHAPTER_ID,
      3,
      12,
      'abc123',
    );
    expect(
      key.startsWith(storage.bookPagesPrefix(BOOK_ID, EDITION_ID, CHAPTER_ID)),
    ).toBe(true);
    expect(scopeForKey(key)).toBe(`${CHAPTER}/pages`);
  });
});
