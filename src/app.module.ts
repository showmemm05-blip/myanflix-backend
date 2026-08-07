import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { StaffModule } from './staff/staff.module';
import { CategoriesModule } from './categories/categories.module';
import { MoviesModule } from './movies/movies.module';
import { VideosModule } from './videos/videos.module';
import { UploadsModule } from './uploads/uploads.module';
import { ProcessingModule } from './processing/processing.module';
import { WalletModule } from './wallet/wallet.module';
import { TransactionsModule } from './transactions/transactions.module';
import { FinanceModule } from './finance/finance.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DepositsModule } from './deposits/deposits.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SubtitlesModule } from './subtitles/subtitles.module';
import { SeriesModule } from './series/series.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Powers UploadCleanupService's daily abandoned-multipart-upload sweep —
    // the first scheduled/cron job anywhere in this backend.
    ScheduleModule.forRoot(),

    AuthModule,
    UsersModule,
    RolesModule,
    StaffModule,
    CategoriesModule,
    MoviesModule,
    VideosModule,
    UploadsModule,
    ProcessingModule,
    WalletModule,
    TransactionsModule,
    FinanceModule,
    AnalyticsModule,
    DepositsModule,
    NotificationsModule,
    RealtimeModule,
    SubtitlesModule,
    SeriesModule,
    SubscriptionsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
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
