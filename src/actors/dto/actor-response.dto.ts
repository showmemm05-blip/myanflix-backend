import type { Actor } from '../../generated/prisma/client';
import type { ImageUrlResolver } from '../../movies/dto/movie-response.dto';

type ActorWithMovieCount = Actor & { _count: { movies: number } };

export class ActorResponseDto {
  static fromEntity(
    actor: ActorWithMovieCount,
    resolveImageUrl: ImageUrlResolver,
  ) {
    return {
      id: actor.id,
      name: actor.name,
      imageUrl: resolveImageUrl(actor.imageUrl),
      // Counted from the join, never stored — a cached number would drift
      // the first time a movie was deleted.
      movieCount: actor._count.movies,
      createdAt: actor.createdAt,
      updatedAt: actor.updatedAt,
    };
  }
}
