import { Module } from '@nestjs/common';
import { RolesModule } from '../roles/roles.module';
import { MinioService } from '../common/storage/minio.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [RolesModule],
  controllers: [FinanceController],
  providers: [FinanceService, MinioService],
})
export class FinanceModule {}
