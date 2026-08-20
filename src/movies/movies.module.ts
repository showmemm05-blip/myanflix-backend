import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { TrackingModule } from '../tracking/tracking.module';
import { VideosModule } from '../videos/videos.module';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';

@Module({
  imports: [RolesModule, TrackingModule, VideosModule],
  controllers: [MoviesController],
  providers: [MoviesService],
  exports: [MoviesService],
})
export class MoviesModule {}
