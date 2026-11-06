import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { StorageService } from '../common/storage/storage.service';
import { RolesModule } from '../roles/roles.module';
import { AdAnalyticsService } from './ad-analytics.service';
import { AdDecisionService } from './ad-decision.service';
import { AdImageService } from './ad-image.service';
import { AdPlaybackCleanupService } from './ad-playback-cleanup.service';
import { AdSettingsService } from './ad-settings.service';
import { AdVideoService } from './ad-video.service';
import { AdsAdminController } from './ads-admin.controller';
import { AdsAdminService } from './ads-admin.service';
import { AdsController } from './ads.controller';

/**
 * Advertisements (2026-11-04): video ads before the movie and at mid-roll
 * breaks, and the corner picture — the staff /ads/admin routes and the
 * viewer's /ads/session, /ads/midroll, /ads/preroll + playback events. MinioService and
 * StorageService are listed like every module that signs playback URLs
 * and builds object keys (see app.module.spec.ts); AuditService is global.
 */
@Module({
  imports: [RolesModule],
  controllers: [AdsAdminController, AdsController],
  providers: [
    AdsAdminService,
    AdVideoService,
    AdImageService,
    AdDecisionService,
    AdAnalyticsService,
    AdPlaybackCleanupService,
    AdSettingsService,
    MinioService,
    StorageService,
  ],
})
export class AdsModule {}
