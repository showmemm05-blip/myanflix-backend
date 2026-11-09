import {
  MovieResponseDto,
  maxQualityOf,
  type MovieQualitySource,
} from './movie-response.dto';
import {
  Prisma,
  type Category,
  type Movie,
} from '../../generated/prisma/client';

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

  describe('the description in each language', () => {
    it('sends the Burmese description beside the English one', () => {
      const result = MovieResponseDto.fromEntity(
        { ...movie, descriptionMm: 'ဖော်ပြချက်' } as typeof movie,
        resolveImageUrl,
      );

      expect(result.description).toBe('A description');
      expect(result.descriptionMm).toBe('ဖော်ပြချက်');
    });

    it('sends null — never undefined — when there is no Burmese text, so the field is always there for the clients to read', () => {
      const none = MovieResponseDto.fromEntity(
        { ...movie, descriptionMm: null } as typeof movie,
        resolveImageUrl,
      );
      // A row that predates the column (as this fixture does).
      const missing = MovieResponseDto.fromEntity(movie, resolveImageUrl);

      expect(none).toHaveProperty('descriptionMm', null);
      expect(missing).toHaveProperty('descriptionMm', null);
    });
  });

  /**
   * This is the shape guests receive. The folder name a title was uploaded
   * from and the TMDB bookkeeping are for staff only (they read them
   * through the /tmdb routes), and because the mapper is a whitelist a new
   * Movie column stays out until someone lists it — this pins that.
   */
  describe('staff-only columns never leave', () => {
    /** A row carrying EVERY scalar column Movie has, read off the generated client. */
    const everyColumn = Object.fromEntries(
      Object.keys(Prisma.MovieScalarFieldEnum).map((column) => [
        column,
        `value-of-${column}`,
      ]),
    ) as unknown as Movie;

    const STAFF_ONLY = [
      'sourceName',
      'tmdbId',
      'tmdbStatus',
      'tmdbError',
      'tmdbFetchedAt',
      'tmdbAuto',
    ];

    it('the fixture really carries them (or this spec would prove nothing)', () => {
      for (const column of STAFF_ONLY) {
        expect(everyColumn).toHaveProperty(column);
      }
    });

    it('drops sourceName and every tmdb column, whatever they hold', () => {
      const result = MovieResponseDto.fromEntity(
        {
          ...everyColumn,
          sourceName: 'Inception.2010.1080p.BluRay.x264-YIFY',
          tmdbId: 27205,
          tmdbStatus: 'MATCHED',
          tmdbError: 'unreachable',
          tmdbFetchedAt: new Date('2026-11-06T00:00:00.000Z'),
          tmdbAuto: { v: 1, title: 'Inception', releaseYear: 2010 },
        } as Movie,
        resolveImageUrl,
      );

      for (const column of STAFF_ONLY) {
        expect(result).not.toHaveProperty(column);
      }
      expect(Object.keys(result).filter((key) => /tmdb/i.test(key))).toEqual(
        [],
      );
      expect(JSON.stringify(result)).not.toContain('YIFY');
    });

    it('sends exactly the fields a client knows — a new Movie column reaches nobody by accident', () => {
      const result = MovieResponseDto.fromEntity(everyColumn, resolveImageUrl);

      expect(Object.keys(result).sort()).toEqual(
        [
          'id',
          'title',
          'description',
          'descriptionMm',
          'posterUrl',
          'coverUrl',
          'thumbnailUrl',
          'genre',
          'language',
          'releaseYear',
          'duration',
          'rating',
          'director',
          'country',
          'ageRating',
          'accessType',
          'status',
          'maxQuality',
          'seriesId',
          'seasonNumber',
          'episodeNumber',
          'categories',
          'actors',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
    });

    it('trims each cast member to id, name and photo — an actor never carries its TMDB person id out', () => {
      const result = MovieResponseDto.fromEntity(
        {
          ...movie,
          actors: [
            {
              id: 'actor-1',
              name: 'Leonardo DiCaprio',
              imageUrl: null,
              tmdbPersonId: 6193,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
        resolveImageUrl,
      );

      expect(result.actors).toEqual([
        { id: 'actor-1', name: 'Leonardo DiCaprio', imageUrl: null },
      ]);
    });
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
