import {
  TMDB_IMAGE_ID_PREFIX,
  isTmdbImageKey,
  replacedTmdbImageKeys,
} from './image-source';

const UUID = '0b5e7c1a-3d2f-4e8a-9b6c-1f2e3d4c5b6a';

describe('isTmdbImageKey', () => {
  it('is true for a picture stored under a tmdb-<uuid> name, in any purpose folder', () => {
    expect(TMDB_IMAGE_ID_PREFIX).toBe('tmdb-');
    for (const purpose of ['movie', 'series', 'actor']) {
      expect(isTmdbImageKey(`images/${purpose}/tmdb-${UUID}.jpg`)).toBe(true);
    }
  });

  it('is false for a staff upload — a bare uuid can never start with "tmdb-"', () => {
    expect(isTmdbImageKey(`images/movie/${UUID}.jpg`)).toBe(false);
    expect(isTmdbImageKey(`images/user/user-1/1730000000000.png`)).toBe(false);
  });

  it('reads the FILE name, not the folders above it', () => {
    expect(isTmdbImageKey(`images/tmdb-movie/${UUID}.jpg`)).toBe(false);
    expect(isTmdbImageKey(`images/ad/tmdb-ad/${UUID}.png`)).toBe(false);
  });

  it('is false outside images/, and for nothing at all', () => {
    expect(isTmdbImageKey(`videos/tmdb-${UUID}/original.mp4`)).toBe(false);
    expect(isTmdbImageKey(`tmdb-${UUID}.jpg`)).toBe(false);
    expect(isTmdbImageKey('')).toBe(false);
    expect(isTmdbImageKey(null)).toBe(false);
    expect(isTmdbImageKey(undefined)).toBe(false);
  });
});

describe('replacedTmdbImageKeys', () => {
  const FIELDS = ['posterUrl', 'coverUrl', 'thumbnailUrl'] as const;
  /** Mirrors MinioService.keyFromPublicUrl: the key follows the bucket segment, whatever the host. */
  const keyOf = (url: string) => /\/movies\/(.+)$/.exec(url)?.[1] ?? null;

  const tmdbPoster = `images/movie/tmdb-${UUID}.jpg`;
  const tmdbCover = `images/movie/tmdb-1f2e3d4c-3d2f-4e8a-9b6c-0b5e7c1a5b6a.jpg`;
  const staffPoster = `images/movie/${UUID}.jpg`;
  const at = (key: string, host = 'cdn.example') =>
    `https://${host}/movies/${key}`;

  it('returns the TMDB picture a staff upload replaced', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: at(tmdbPoster), coverUrl: at(tmdbCover) },
        { posterUrl: at(staffPoster), coverUrl: at(tmdbCover) },
        FIELDS,
        keyOf,
      ),
    ).toEqual([tmdbPoster]);
  });

  it('returns it when the field was cleared, and every field that changed', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: at(tmdbPoster), coverUrl: at(tmdbCover) },
        { posterUrl: null, coverUrl: at(staffPoster) },
        FIELDS,
        keyOf,
      ).sort(),
    ).toEqual([tmdbPoster, tmdbCover].sort());
  });

  it('never returns a staff picture — only TMDB ones are cleaned up', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: at(staffPoster) },
        { posterUrl: at(tmdbPoster) },
        FIELDS,
        keyOf,
      ),
    ).toEqual([]);
  });

  it('returns nothing when nothing changed', () => {
    const row = { posterUrl: at(tmdbPoster), coverUrl: null };
    expect(replacedTmdbImageKeys(row, { ...row }, FIELDS, keyOf)).toEqual([]);
  });

  it('the same object saved back under another host is not a change', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: at(tmdbPoster, '192.168.1.20:8080') },
        { posterUrl: at(tmdbPoster, 'localhost:8080') },
        FIELDS,
        keyOf,
      ),
    ).toEqual([]);
  });

  it('keeps an object another image field of the row still shows', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: at(tmdbPoster), coverUrl: null },
        { posterUrl: at(staffPoster), coverUrl: at(tmdbPoster) },
        FIELDS,
        keyOf,
      ),
    ).toEqual([]);
  });

  it('ignores an old value that is not one of our objects (an external URL)', () => {
    expect(
      replacedTmdbImageKeys(
        { posterUrl: 'https://image.tmdb.org/t/p/w500/tmdb-abc.jpg' },
        { posterUrl: at(staffPoster) },
        FIELDS,
        keyOf,
      ),
    ).toEqual([]);
  });

  it('reads only the fields it is given, and tolerates rows that lack them', () => {
    const row = { posterUrl: at(tmdbPoster), coverUrl: at(tmdbCover) };
    expect(replacedTmdbImageKeys(row, {}, ['posterUrl'], keyOf)).toEqual([
      tmdbPoster,
    ]);
    expect(replacedTmdbImageKeys({}, {}, FIELDS, keyOf)).toEqual([]);
  });
});
