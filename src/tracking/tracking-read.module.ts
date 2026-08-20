import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrackingController } from './tracking.controller';
import { TrackingReadService } from './tracking-read.service';

/**
 * The admin-facing READ half of tracking, deliberately a second module in
 * this folder rather than more providers on TrackingModule.
 *
 * The reason is a module cycle, not taste. TrackingModule is imported by
 * MoviesModule, VideosModule and AuthModule — it has to sit at the very
 * bottom of the graph, depending on nothing but the @Global PrismaModule.
 * This half needs RealtimeModule for live socket presence, and
 * RealtimeModule -> UsersModule -> MoviesModule -> TrackingModule, so
 * hanging the gateway off TrackingModule would close a require cycle that
 * `forwardRef` can paper over at the DI level but not at the module-loading
 * level (see the comment in users.module.ts for what that failure looks
 * like).
 *
 * This module is a leaf: nothing imports it, so it can depend on whatever
 * it likes. PermissionResolverService — the resolver both the route guard
 * and the service's PII gate use — comes from the @Global RolesModule.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [TrackingController],
  providers: [TrackingReadService],
  exports: [TrackingReadService],
})
export class TrackingReadModule {}
