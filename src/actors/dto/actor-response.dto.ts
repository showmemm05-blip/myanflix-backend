import type { ImageUrlResolver } from '../../movies/dto/movie-response.dto';
import type { ActorWithCounts } from '../actors.service';

export class ActorResponseDto {
  static fromEntity(actor: ActorWithCounts, resolveImageUrl: ImageUrlResolver) {
    return {
      id: actor.id,
      name: actor.name,
      imageUrl: resolveImageUrl(actor.imageUrl),
      // Both counted from the joins, never stored — a cached number would
      // drift the first time a title was deleted. movieCount is STANDALONE
      // films only (what GET /movies?actorIds= can list); seriesCount is the
      // distinct series the person is on, at show level or on any episode
      // (what GET /series?actorIds= lists). Together they are every credit.
      movieCount: actor._count.movies,
      seriesCount: actor.seriesCount,
      createdAt: actor.createdAt,
      updatedAt: actor.updatedAt,
    };
  }
}
