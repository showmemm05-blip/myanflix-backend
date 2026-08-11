import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';

@Module({
  imports: [RolesModule],
  controllers: [FinanceSettingsController],
  providers: [FinanceSettingsService],
  exports: [FinanceSettingsService],
})
export class FinanceSettingsModule {}
