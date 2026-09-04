import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { LevelsController } from './levels.controller';
import { LevelsService } from './levels.service';

@Module({
  imports: [RolesModule],
  controllers: [LevelsController],
  providers: [LevelsService],
  exports: [LevelsService],
})
export class LevelsModule {}
