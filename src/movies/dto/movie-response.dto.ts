import { decimalToNumber } from '../../common/utils/decimal.util';
import type { Category, Movie } from '../../generated/prisma/client';

type MovieWithCategories = Movie & { categories?: Category[] };

export class MovieResponseDto {
  static fromEntity(movie: MovieWithCategories) {
    return {
      id: movie.id,
      title: movie.title,
      description: movie.description,
      posterUrl: movie.posterUrl,
      coverUrl: movie.coverUrl,
      thumbnailUrl: movie.thumbnailUrl,
      genre: movie.genre,
      language: movie.language,
      releaseYear: movie.releaseYear,
      duration: movie.duration,
      rating: movie.rating,
      price: decimalToNumber(movie.price),
      isPremium: movie.isPremium,
      status: movie.status,
      seriesId: movie.seriesId,
      seasonNumber: movie.seasonNumber,
      episodeNumber: movie.episodeNumber,
      categories: movie.categories?.map((c) => ({ id: c.id, name: c.name })) ?? [],
      createdAt: movie.createdAt,
      updatedAt: movie.updatedAt,
    };
  }
}
