import { Module } from '@nestjs/common';
import { ImagesModule } from '../images/images.module';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { TmdbCastService } from './tmdb-cast.service';
import { TmdbFillService } from './tmdb-fill.service';
import { TmdbImageFetcher } from './tmdb-image.fetcher';
import { TmdbLookupService } from './tmdb-lookup.service';
import { TmdbRunRegistry } from './tmdb-runs';
import { TmdbSearchService } from './tmdb-search.service';
import { TmdbStateService } from './tmdb-state.service';
import { TmdbStatusService } from './tmdb-status.service';
import { TmdbClient } from './tmdb.client';
import { TmdbController } from './tmdb.controller';

/**
 * Movie and series details from TMDB (2026-11-06,
 * docs/movie-details-tmdb-2026-11-06/PLAN.md): the staff /tmdb routes and
 * the lookup that runs after a folder upload finishes.
 *
 * ImagesModule gives the image store every TMDB picture is saved through;
 * VideosModule is imported for MinioService, which it owns and exports;
 * RolesModule gives the guard and the permission resolver (the
 * ACTORS.CREATE check of a fill). AuditService and PrismaService are
 * global.
 *
 * TmdbLookupService is exported for UploadsModule, which starts a lookup
 * as the last step of a finalize. This module imports none of
 * MoviesModule, SeriesModule, ActorsModule or UploadsModule — it reads and
 * writes those rows through Prisma and uses only their pure helpers
 * (MovieResponseDto, toSeriesResponse, the audit snapshots) — so the
 * import from UploadsModule cannot close a cycle.
 */
@Module({
  imports: [RolesModule, VideosModule, ImagesModule],
  controllers: [TmdbController],
  providers: [
    TmdbClient,
    TmdbImageFetcher,
    TmdbRunRegistry,
    TmdbCastService,
    TmdbFillService,
    TmdbLookupService,
    TmdbSearchService,
    TmdbStateService,
    TmdbStatusService,
  ],
  exports: [TmdbLookupService],
})
export class TmdbModule {}
