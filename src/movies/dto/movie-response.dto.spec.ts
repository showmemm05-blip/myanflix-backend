import { MovieResponseDto } from './movie-response.dto';
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
    posterUrl: 'http://192.168.10.122:8080/movies/images/poster.jpeg',
    coverUrl: 'http://192.168.10.122:8080/movies/images/cover.jpeg',
    thumbnailUrl: 'http://192.168.10.122:8080/movies/images/thumb.jpeg',
    genre: 'Drama',
    language: 'Burmese',
    releaseYear: 2024,
    duration: 118,
    rating: 4.5,
    accessType: 'SUBSCRIPTION',
    status: 'PUBLISHED',
    seriesId: null,
    seasonNumber: null,
    episodeNumber: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    categories: [{ id: 'cat-1', name: 'Action' }] as Category[],
  } as unknown as Movie & { categories: Category[] };

  beforeEach(() => resolveImageUrl.mockClear());

  it('re-hosts every one of the three persisted image fields', () => {
    const result = MovieResponseDto.fromEntity(movie, resolveImageUrl);

    expect(result.posterUrl).toBe(
      'http://current-host:8080/movies/images/poster.jpeg',
    );
    expect(result.coverUrl).toBe(
      'http://current-host:8080/movies/images/cover.jpeg',
    );
    expect(result.thumbnailUrl).toBe(
      'http://current-host:8080/movies/images/thumb.jpeg',
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
});
