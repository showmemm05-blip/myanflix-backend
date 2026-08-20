import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';

/**
 * The write half of tracking: search terms, watch-activity buckets and
 * session/presence rows.
 *
 * Depends on nothing but PrismaModule (which is @Global), so any module can
 * import it without creating a cycle — MoviesModule, VideosModule and
 * AuthModule all do, and all three sit at very different depths of the
 * dependency graph.
 */
@Module({
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
