import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { UsersModule } from '../users/users.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [RolesModule, UsersModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
