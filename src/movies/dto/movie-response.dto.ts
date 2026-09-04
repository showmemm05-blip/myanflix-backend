import type { Actor, Category, Movie } from '../../generated/prisma/client';

type MovieWithCategories = Movie & {
  categories?: Category[];
  actors?: Actor[];
};

/**
 * Re-derives a persisted image URL's host from the current request — see
 * MinioService.imageUrl. Threaded in as an argument because fromEntity() is
 * static and has no DI access to MinioService; every caller passes its own
 * injected instance's method rather than constructing one or reading env
 * vars directly.
 */
export type ImageUrlResolver = (
  url: string | null | undefined,
) => string | null;

export class MovieResponseDto {
  static fromEntity(
    movie: MovieWithCategories,
    resolveImageUrl: ImageUrlResolver,
  ) {
    return {
      id: movie.id,
      title: movie.title,
      description: movie.description,
      posterUrl: resolveImageUrl(movie.posterUrl),
      coverUrl: resolveImageUrl(movie.coverUrl),
      thumbnailUrl: resolveImageUrl(movie.thumbnailUrl),
      genre: movie.genre,
      language: movie.language,
      releaseYear: movie.releaseYear,
      duration: movie.duration,
      rating: movie.rating,
      // Nullable filter metadata — null passes through untouched (it means
      // "not set", which is real information the clients' auto-hide rule
      // depends on).
      director: movie.director,
      country: movie.country,
      ageRating: movie.ageRating,
      accessType: movie.accessType,
      status: movie.status,
      seriesId: movie.seriesId,
      seasonNumber: movie.seasonNumber,
      episodeNumber: movie.episodeNumber,
      categories:
        movie.categories?.map((c) => ({ id: c.id, name: c.name })) ?? [],
      actors:
        movie.actors?.map((a) => ({
          id: a.id,
          name: a.name,
          imageUrl: resolveImageUrl(a.imageUrl),
        })) ?? [],
      createdAt: movie.createdAt,
      updatedAt: movie.updatedAt,
    };
  }
}
