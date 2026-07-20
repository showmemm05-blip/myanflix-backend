import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [RolesModule],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
