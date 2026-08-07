import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [RolesModule],
  controllers: [SeriesController],
  providers: [SeriesService],
  exports: [SeriesService],
})
export class SeriesModule {}
