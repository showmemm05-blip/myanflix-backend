import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { VideosModule } from '../videos/videos.module';
import { ActorsController } from './actors.controller';
import { ActorsService } from './actors.service';

/**
 * VideosModule is imported for MinioService, which it owns and exports — the
 * same reason MoviesModule imports it. Actors need it only to clean up a
 * headshot when one is replaced or its row deleted.
 */
@Module({
  imports: [RolesModule, VideosModule],
  controllers: [ActorsController],
  providers: [ActorsService],
  exports: [ActorsService],
})
export class ActorsModule {}
