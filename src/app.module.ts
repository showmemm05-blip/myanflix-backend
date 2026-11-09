import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';

import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { AuditModule } from './audit/audit.module';
import { SessionRevocationModule } from './auth/session-revocation.module';
import { StaffModule } from './staff/staff.module';
import { CategoriesModule } from './categories/categories.module';
import { ActorsModule } from './actors/actors.module';
import { BookCategoriesModule } from './book-categories/book-categories.module';
import { BookAuthorsModule } from './book-authors/book-authors.module';
import { BooksModule } from './books/books.module';
import { MoviesModule } from './movies/movies.module';
import { VideosModule } from './videos/videos.module';
import { UploadsModule } from './uploads/uploads.module';
import { ProcessingModule } from './processing/processing.module';
import { WalletModule } from './wallet/wallet.module';
import { TransactionsModule } from './transactions/transactions.module';
import { FinanceModule } from './finance/finance.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DepositsModule } from './deposits/deposits.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { WithdrawalCodeModule } from './withdrawal-code/withdrawal-code.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SubtitlesModule } from './subtitles/subtitles.module';
import { SeriesModule } from './series/series.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { PaymentAccountsModule } from './payment-accounts/payment-accounts.module';
import { FinanceSettingsModule } from './finance-settings/finance-settings.module';
import { PeakUsersModule } from './peak-users/peak-users.module';
import { TrackingModule } from './tracking/tracking.module';
import { TrackingReadModule } from './tracking/tracking-read.module';
import { CommentsModule } from './comments/comments.module';
import { FeedbackModule } from './feedback/feedback.module';
import { LevelsModule } from './levels/levels.module';
import { BankEventsModule } from './bank-events/bank-events.module';
import { BankTransactionsModule } from './bank-transactions/bank-transactions.module';
import { SmsGatewayModule } from './sms-gateway/sms-gateway.module';
import { HomeModule } from './home/home.module';
import { LotteryModule } from './lottery/lottery.module';
import { AdsModule } from './ads/ads.module';
import { TmdbModule } from './tmdb/tmdb.module';
import { HealthModule } from './health/health.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AppThrottlerGuard } from './common/throttling/app-throttler.guard';
import { buildThrottlerOptions } from './common/throttling/throttling.config';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Powers UploadCleanupService's daily abandoned-multipart-upload sweep —
    // the first scheduled/cron job anywhere in this backend.
    ScheduleModule.forRoot(),
    // Rate limiting — see common/throttling/throttling.config.ts for the
    // buckets. Enforced by AppThrottlerGuard below.
    ThrottlerModule.forRoot(buildThrottlerOptions()),

    AuthModule,
    UsersModule,
    RolesModule,
    AuditModule,
    SessionRevocationModule,
    StaffModule,
    CategoriesModule,
    ActorsModule,
    MoviesModule,
    VideosModule,
    UploadsModule,
    ProcessingModule,
    WalletModule,
    TransactionsModule,
    FinanceModule,
    AnalyticsModule,
    DepositsModule,
    WithdrawalsModule,
    // Also reached through WithdrawalsModule; listed so the
    // /users/me/withdrawal-code routes do not depend on that chain.
    WithdrawalCodeModule,
    NotificationsModule,
    RealtimeModule,
    SubtitlesModule,
    SeriesModule,
    BooksModule,
    BookCategoriesModule,
    BookAuthorsModule,
    SubscriptionsModule,
    PaymentAccountsModule,
    FinanceSettingsModule,
    PeakUsersModule,
    TrackingModule,
    TrackingReadModule,
    CommentsModule,
    FeedbackModule,
    LevelsModule,
    BankEventsModule,
    BankTransactionsModule,
    // The company-phone SMS gateway's device + staff-status routes. Also
    // reached through Auth -> Otp -> Sms; listed here so the routes do not
    // depend on that chain.
    SmsGatewayModule,
    // The home showcase: public GET /home/showcase + the staff "Home promos"
    // routes (2026-10-08).
    HomeModule,
    // The Lottery (2026-10-19). Phase 1: the public dream books + the staff
    // /lottery/admin/dreams routes. Phase 2: the public draws, the staff
    // /lottery/admin/draws + /lottery/admin/settings routes, the minute cron
    // that closes sales, and the customer's /lottery/purchases + /lottery/tickets.
    LotteryModule,
    // Pre-roll video ads (2026-11-04): the staff /ads/admin routes (list,
    // form, video attach, analytics) and the viewer's POST /ads/preroll +
    // playback events.
    AdsModule,
    // Movie and series details from TMDB (2026-11-06): the staff /tmdb
    // routes (status, search, review, apply, a series created from TMDB).
    // Also reached through UploadsModule, which starts a lookup when a
    // folder upload finishes; listed so the routes do not depend on that
    // chain. Off, with every upload unchanged, while TMDB_API_KEY is unset.
    TmdbModule,
    // GET /api/health — 200 while the database answers, 503 once it does
    // not; what the compose healthcheck and the admin's network check poll
    // (2026-10-09, OPS-005). Replaces the old AppController/AppService.
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Keep this AFTER JwtAuthGuard: on a signed-in route with
    // @ThrottleAuth() (POST /withdrawals, the withdrawal-code routes) the
    // per-credential bucket keys on `req.user`, which JwtAuthGuard sets. The
    // @Public auth routes do not care (they key on phone/username/IP).
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
