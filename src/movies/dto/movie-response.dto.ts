import type {
  Actor,
  Category,
  Movie,
  Prisma,
  VideoStatus,
} from '../../generated/prisma/client';

/**
 * The slice of a Video row the quality badge reads — see CATALOG_INCLUDE.
 * Structural rather than the generated Video type so both the narrow catalogue
 * `select` and a fuller `include` satisfy it.
 */
export interface MovieQualitySource {
  status: VideoStatus;
  renditions: Prisma.JsonValue;
}

type MovieWithCategories = Movie & {
  categories?: Category[];
  actors?: Actor[];
  videos?: MovieQualitySource[];
};

/** Rendition entries are free-form JSON on the Video row; this is the shape we read. */
interface RenditionEntry {
  resolution?: unknown;
}

/**
 * The highest rendition this title genuinely has on disk, under its own name
 * ("720p"), or null when nothing is transcoded yet.
 *
 * Read from the READY video's `renditions` rather than the source
 * `resolution` column on purpose: the source is what an operator uploaded,
 * the renditions are what a viewer can actually be served — badging a 4K
 * source whose ladder tops out at 720p would be a lie. The name is passed
 * through verbatim so the ladder can grow without a backend change; clients
 * decide how to print it, and anything unparseable badges nothing.
 */
export function maxQualityOf(
  videos: MovieQualitySource[] | null | undefined,
): string | null {
  if (!videos?.length) return null;
  let bestHeight = 0;
  let best: string | null = null;
  for (const video of videos) {
    if (video.status !== 'READY') continue;
    if (!Array.isArray(video.renditions)) continue;
    for (const entry of video.renditions as RenditionEntry[]) {
      const name = entry?.resolution;
      if (typeof name !== 'string') continue;
      const height = Number.parseInt(name, 10);
      if (!Number.isFinite(height) || height <= bestHeight) continue;
      bestHeight = height;
      best = name;
    }
  }
  return best;
}

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
      // Null wherever the relation was not loaded or nothing is transcoded —
      // the clients drop the badge rather than guess at a resolution.
      maxQuality: maxQualityOf(movie.videos),
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
