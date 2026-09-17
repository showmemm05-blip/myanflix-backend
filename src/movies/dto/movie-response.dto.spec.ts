import {
  MovieResponseDto,
  maxQualityOf,
  type MovieQualitySource,
} from './movie-response.dto';
import type { Category, Movie } from '../../generated/prisma/client';

/**
 * The mapper every movie/episode response goes through (movies list/detail/
 * create/update/most-purchased, and the series module's episode listings).
 * Its three image fields are persisted absolute with a baked-in host, so
 * each one has to be handed to the resolver rather than copied straight out
 * of the row.
 */
describe('MovieResponseDto.fromEntity', () => {
  // Stand-in for MinioService.imageUrl: re-hosts our own URLs, passes
  // external ones through, null stays null.
  const resolveImageUrl = jest.fn((url: string | null | undefined) => {
    if (!url) return url ?? null;
    const match = /\/movies\/(.+)$/.exec(url);
    return match ? `http://current-host:8080/movies/${match[1]}` : url;
  });

  const movie = {
    id: 'movie-1',
    title: 'Some Title',
    description: 'A description',
    // Baked with a LAN IP the machine no longer has.
    posterUrl: 'http://192.168.10.122:8080/movies/images/movie/poster.jpeg',
    coverUrl: 'http://192.168.10.122:8080/movies/images/movie/cover.jpeg',
    thumbnailUrl: 'http://192.168.10.122:8080/movies/images/movie/thumb.jpeg',
    genre: 'Drama',
    language: 'Burmese',
    releaseYear: 2024,
    duration: 118,
    rating: 4.5,
    director: 'Some Director',
    country: 'Myanmar',
    ageRating: 'PG13',
    accessType: 'SUBSCRIPTION',
    status: 'PUBLISHED',
    seriesId: null,
    seasonNumber: null,
    episodeNumber: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    categories: [{ id: 'cat-1', name: 'Action' }] as Category[],
  } as unknown as Movie & { categories: Category[] };

  const withVideos = (videos: MovieQualitySource[]) =>
    ({ ...movie, videos }) as typeof movie & { videos: MovieQualitySource[] };

  beforeEach(() => resolveImageUrl.mockClear());

  it('re-hosts every one of the three persisted image fields', () => {
    const result = MovieResponseDto.fromEntity(movie, resolveImageUrl);

    expect(result.posterUrl).toBe(
      'http://current-host:8080/movies/images/movie/poster.jpeg',
    );
    expect(result.coverUrl).toBe(
      'http://current-host:8080/movies/images/movie/cover.jpeg',
    );
    expect(result.thumbnailUrl).toBe(
      'http://current-host:8080/movies/images/movie/thumb.jpeg',
    );
    // Regression guard: a field added later must go through the resolver
    // too, not be copied straight off the row.
    expect(resolveImageUrl).toHaveBeenCalledTimes(3);
  });

  it('leaves every non-image field exactly as it was', () => {
    const result = MovieResponseDto.fromEntity(movie, resolveImageUrl);

    expect(result).toMatchObject({
      id: 'movie-1',
      title: 'Some Title',
      description: 'A description',
      genre: 'Drama',
      language: 'Burmese',
      releaseYear: 2024,
      duration: 118,
      rating: 4.5,
      director: 'Some Director',
      country: 'Myanmar',
      ageRating: 'PG13',
      accessType: 'SUBSCRIPTION',
      status: 'PUBLISHED',
      seriesId: null,
      seasonNumber: null,
      episodeNumber: null,
      categories: [{ id: 'cat-1', name: 'Action' }],
      createdAt: movie.createdAt,
      updatedAt: movie.updatedAt,
    });
  });

  it('passes NULL optional metadata through untouched — "not set" is real information the auto-hide rule needs', () => {
    const result = MovieResponseDto.fromEntity(
      {
        ...movie,
        director: null,
        country: null,
        ageRating: null,
      } as typeof movie,
      resolveImageUrl,
    );

    expect(result.director).toBeNull();
    expect(result.country).toBeNull();
    expect(result.ageRating).toBeNull();
  });

  it('passes an external poster through and keeps a missing one null', () => {
    const result = MovieResponseDto.fromEntity(
      {
        ...movie,
        posterUrl: 'https://picsum.photos/seed/Some%20Title/400/600',
        coverUrl: null,
        thumbnailUrl: null,
      },
      resolveImageUrl,
    );

    expect(result.posterUrl).toBe(
      'https://picsum.photos/seed/Some%20Title/400/600',
    );
    expect(result.coverUrl).toBeNull();
    expect(result.thumbnailUrl).toBeNull();
  });

  it('reports the highest READY rendition as maxQuality', () => {
    const result = MovieResponseDto.fromEntity(
      withVideos([
        {
          status: 'READY',
          renditions: [
            { resolution: '240p' },
            { resolution: '480p' },
            { resolution: '720p' },
          ],
        },
      ]),
      resolveImageUrl,
    );

    expect(result.maxQuality).toBe('720p');
  });

  it('leaves maxQuality null when the relation was not loaded', () => {
    expect(MovieResponseDto.fromEntity(movie, resolveImageUrl).maxQuality).toBe(
      null,
    );
  });
});

/**
 * The badge is the one field derived rather than copied, and it is a promise
 * about what a viewer can actually be served — so every way the data can be
 * partial has to end in "no badge" rather than a guess.
 */
describe('maxQualityOf', () => {
  it('returns null with no videos at all', () => {
    expect(maxQualityOf([])).toBeNull();
    expect(maxQualityOf(undefined)).toBeNull();
  });

  it('ignores a video that is still processing — nothing is servable yet', () => {
    expect(
      maxQualityOf([
        { status: 'PROCESSING', renditions: [{ resolution: '1080p' }] },
      ]),
    ).toBeNull();
  });

  it('takes the highest across several READY videos', () => {
    expect(
      maxQualityOf([
        { status: 'READY', renditions: [{ resolution: '480p' }] },
        { status: 'READY', renditions: [{ resolution: '1080p' }] },
      ]),
    ).toBe('1080p');
  });

  it('passes an unseen rendition name through so the ladder can grow without a backend change', () => {
    expect(
      maxQualityOf([
        {
          status: 'READY',
          renditions: [{ resolution: '1080p' }, { resolution: '2160p' }],
        },
      ]),
    ).toBe('2160p');
  });

  it('badges nothing when the JSON is not the shape we expect', () => {
    expect(maxQualityOf([{ status: 'READY', renditions: null }])).toBeNull();
    expect(
      maxQualityOf([{ status: 'READY', renditions: { resolution: '720p' } }]),
    ).toBeNull();
    expect(
      maxQualityOf([{ status: 'READY', renditions: [{ resolution: 42 }] }]),
    ).toBeNull();
    expect(
      maxQualityOf([{ status: 'READY', renditions: [{ resolution: 'hd' }] }]),
    ).toBeNull();
  });
});
