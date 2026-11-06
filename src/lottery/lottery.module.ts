import { Module } from '@nestjs/common';
import { MinioService } from '../common/storage/minio.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { RolesModule } from '../roles/roles.module';
import { WalletModule } from '../wallet/wallet.module';
import { LotteryActivityController } from './analytics/lottery-activity.controller';
import { LotteryActivityService } from './analytics/lottery-activity.service';
import { LotteryAnalyticsAdminController } from './analytics/lottery-analytics-admin.controller';
import { LotteryAnalyticsService } from './analytics/lottery-analytics.service';
import { LotteryClaimExpiryService } from './claims/lottery-claim-expiry.service';
import { LotteryClaimsAdminController } from './claims/lottery-claims-admin.controller';
import { LotteryClaimsAdminService } from './claims/lottery-claims-admin.service';
import { LotteryClaimsController } from './claims/lottery-claims.controller';
import { LotteryClaimsService } from './claims/lottery-claims.service';
import { LotteryDrawCloserService } from './lottery-draw-closer.service';
import { LotteryDrawsAdminController } from './lottery-draws-admin.controller';
import { LotteryDrawsAdminService } from './lottery-draws-admin.service';
import { LotteryDrawsController } from './lottery-draws.controller';
import { LotteryDrawsService } from './lottery-draws.service';
import { LotteryDreamsAdminController } from './lottery-dreams-admin.controller';
import { LotteryDreamsController } from './lottery-dreams.controller';
import { LotteryDreamsService } from './lottery-dreams.service';
import { LotteryPurchasesController } from './lottery-purchases.controller';
import { LotteryPurchasesService } from './lottery-purchases.service';
import { LotterySettingsAdminController } from './lottery-settings-admin.controller';
import { LotterySettingsService } from './lottery-settings.service';
import { LotteryTicketsController } from './lottery-tickets.controller';
import { LotteryTicketsService } from './lottery-tickets.service';
import { LotteryPublicResultsService } from './results/lottery-public-results.service';
import { LotteryPublishAdminController } from './results/lottery-publish-admin.controller';
import { LotteryPublishService } from './results/lottery-publish.service';
import { LotteryResultsAdminController } from './results/lottery-results-admin.controller';
import { LotteryResultsFetcherService } from './results/lottery-results-fetcher.service';
import { LotteryResultsSourceFactory } from './results/lottery-results-source.factory';
import { LotteryResultsController } from './results/lottery-results.controller';
import { LotteryResultsService } from './results/lottery-results.service';

/**
 * The Lottery. Phase 1: the dream books — public GET /lottery/dreams* plus
 * the staff /lottery/admin/dreams routes. Phase 2: the draws — public
 * GET /lottery/draws* (current / list / one / availability), the staff
 * /lottery/admin/draws and /lottery/admin/settings routes, the minute
 * cron that closes sales on time, and the customer's own
 * /lottery/purchases and /lottery/tickets (WalletModule for the debit,
 * RealtimeModule for the balance push, like SubscriptionsModule).
 * Phase 3: the results — the staff /lottery/admin/draws/:id/results*
 * routes and /lottery/admin/settings/results-test, the five-minute cron
 * that fetches the winning numbers from the results source once the Thai
 * draw time has passed (results/), the pure matcher the publish and
 * the apps share, "Publish results" with its preview and winners table
 * (/lottery/admin/draws/:id/publish*, …/winners), and the public results
 * reads (GET /lottery/results, /lottery/draws/:drawNo/results,
 * /lottery/draws/:drawNo/winners). Analytics (2026-10-23, analytics/):
 * the customer's "I am in the lottery" ping POST /lottery/activity and
 * the staff /lottery/admin/analytics/* reads (overview, activity,
 * numbers, numbers/across, frequency, heatmap, before-close, draws) —
 * every figure aggregated in SQL and bucketed in Myanmar time. Prize
 * claims (2026-10-24, claims/): publishing only AWARDS prizes; the
 * customer requests payment (/lottery/claims*, one claim per draw) and a
 * staff member confirms or rejects it on /lottery/admin/claims* (the
 * confirm is the one wallet credit — WalletModule, RealtimeModule for the
 * balance push); the hourly cron expires the prizes never requested by
 * the draw's claim deadline.
 * MinioService is listed in providers like every module that re-hosts
 * image URLs (see app.module.spec.ts); AuditService is global.
 */
@Module({
  imports: [RolesModule, WalletModule, RealtimeModule],
  controllers: [
    LotteryDreamsController,
    LotteryDreamsAdminController,
    LotteryDrawsController,
    LotteryDrawsAdminController,
    LotterySettingsAdminController,
    LotteryPurchasesController,
    LotteryTicketsController,
    LotteryResultsAdminController,
    LotteryPublishAdminController,
    LotteryResultsController,
    LotteryActivityController,
    LotteryAnalyticsAdminController,
    LotteryClaimsController,
    LotteryClaimsAdminController,
  ],
  providers: [
    LotteryDreamsService,
    LotterySettingsService,
    LotteryDrawsService,
    LotteryDrawsAdminService,
    LotteryDrawCloserService,
    LotteryPurchasesService,
    LotteryTicketsService,
    LotteryResultsSourceFactory,
    LotteryResultsService,
    LotteryResultsFetcherService,
    LotteryPublishService,
    LotteryPublicResultsService,
    LotteryActivityService,
    LotteryAnalyticsService,
    LotteryClaimsService,
    LotteryClaimsAdminService,
    LotteryClaimExpiryService,
    MinioService,
  ],
  exports: [LotterySettingsService, LotteryDrawsService, LotteryResultsService],
})
export class LotteryModule {}
