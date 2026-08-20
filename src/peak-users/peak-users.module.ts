import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { PeakUsersController } from './peak-users.controller';
import { PeakUsersService } from './peak-users.service';

@Module({
  imports: [RolesModule],
  controllers: [PeakUsersController],
  providers: [PeakUsersService],
  exports: [PeakUsersService],
})
export class PeakUsersModule {}
