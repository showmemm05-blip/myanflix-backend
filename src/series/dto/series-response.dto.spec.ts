import { Prisma, type Actor } from '../../generated/prisma/client';
import {
  SERIES_STAFF_ONLY_FIELDS,
  toSeriesResponse,
} from './series-response.dto';

/**
 * A series response is the stored row passed through — a new column on
 * Series reaches every client, guests included, the day it is added. The
 * staff-only ones are taken out by name, so this spec makes the choice
 * explicit: every scalar column of Series is either on the list a client may
 * read or on the staff-only list, and a column on neither fails here until
 * someone decides.
 */
describe('toSeriesResponse', () => {
  // Stand-in for MinioService.imageUrl: re-hosts our own URLs, passes
  // external ones through, null stays null.
  const resolveImageUrl = (url: string | null | undefined) => {
    if (!url) return url ?? null;
    const match = /\/movies\/(.+)$/.exec(url);
    return match ? `http://current-host:8080/movies/${match[1]}` : url;
  };

  /** Every scalar column Series has, read off the generated client. */
  const columns = Object.keys(Prisma.SeriesScalarFieldEnum);

  /** The columns a client may read. Add a new public column here. */
  const CLIENT_COLUMNS = [
    'id',
    'title',
    'description',
    'descriptionMm',
    'posterUrl',
    'coverUrl',
    'genre',
    'language',
    'country',
    'releaseYear',
    'rating',
    'accessType',
    'status',
    'createdAt',
    'updatedAt',
  ];

  const stored = {
    id: 'series-1',
    title: 'Stranger Things',
    description: 'A town.',
    descriptionMm: 'မြို့ငယ်လေးတစ်မြို့',
    posterUrl: 'http://192.168.10.122:8080/movies/images/series/poster.jpg',
    coverUrl: null,
    genre: 'Sci-Fi',
    language: 'English',
    country: 'English',
    releaseYear: 2016,
    rating: 8.6,
    accessType: 'SUBSCRIPTION',
    status: 'PUBLISHED',
    tmdbId: 66732,
    tmdbFetchedAt: new Date('2026-11-06T00:00:00.000Z'),
    tmdbAuto: { v: 1, title: 'Stranger Things', releaseYear: 2016 },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  it('the staff-only list is exactly the TMDB bookkeeping', () => {
    expect([...SERIES_STAFF_ONLY_FIELDS].sort()).toEqual(
      ['tmdbAuto', 'tmdbFetchedAt', 'tmdbId'].sort(),
    );
  });

  it('every Series column is either readable by a client or staff-only — never undecided', () => {
    expect([...CLIENT_COLUMNS, ...SERIES_STAFF_ONLY_FIELDS].sort()).toEqual(
      [...columns].sort(),
    );
    // The fixture carries them all, so the cases below really test the row.
    expect(Object.keys(stored).sort()).toEqual([...columns].sort());
  });

  it('drops tmdbId, tmdbFetchedAt and tmdbAuto and keeps every other column', () => {
    const response = toSeriesResponse(stored, resolveImageUrl);

    expect(Object.keys(response).sort()).toEqual(
      [...CLIENT_COLUMNS, 'actors'].sort(),
    );
    expect(response).not.toHaveProperty('tmdbId');
    expect(response).not.toHaveProperty('tmdbFetchedAt');
    expect(response).not.toHaveProperty('tmdbAuto');
    expect(JSON.stringify(response)).not.toContain('66732');
  });

  it('passes the Burmese description through untouched, null included', () => {
    expect(toSeriesResponse(stored, resolveImageUrl).descriptionMm).toBe(
      'မြို့ငယ်လေးတစ်မြို့',
    );
    expect(
      toSeriesResponse({ ...stored, descriptionMm: null }, resolveImageUrl),
    ).toHaveProperty('descriptionMm', null);
  });

  it('re-hosts the poster and the cover, leaving an external URL and a missing one alone', () => {
    expect(toSeriesResponse(stored, resolveImageUrl)).toMatchObject({
      posterUrl: 'http://current-host:8080/movies/images/series/poster.jpg',
      coverUrl: null,
    });
    expect(
      toSeriesResponse(
        { ...stored, posterUrl: 'https://picsum.photos/seed/x/400/600' },
        resolveImageUrl,
      ).posterUrl,
    ).toBe('https://picsum.photos/seed/x/400/600');
  });

  it('trims the cast to id, name and photo — an actor never carries its TMDB person id out', () => {
    const actor: Actor = {
      id: 'actor-1',
      name: 'Winona Ryder',
      imageUrl: 'http://192.168.10.122:8080/movies/images/actor/tmdb-abc.jpg',
      tmdbPersonId: 1920,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(
      toSeriesResponse({ ...stored, actors: [actor] }, resolveImageUrl).actors,
    ).toEqual([
      {
        id: 'actor-1',
        name: 'Winona Ryder',
        imageUrl: 'http://current-host:8080/movies/images/actor/tmdb-abc.jpg',
      },
    ]);
    // A row loaded without the relation answers with an empty cast.
    expect(toSeriesResponse(stored, resolveImageUrl).actors).toEqual([]);
  });

  it('keeps whatever else the row carries (the list adds an episode count) and never changes the row it was given', () => {
    const row = { ...stored, categories: [{ id: 'c1', name: 'Drama' }] };

    const response = toSeriesResponse(row, resolveImageUrl);

    expect(response.categories).toEqual([{ id: 'c1', name: 'Drama' }]);
    expect(row.tmdbId).toBe(66732);
    expect(row.posterUrl).toBe(stored.posterUrl);
  });
});
