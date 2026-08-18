import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletAdjustmentsService } from './wallet-adjustments.service';

@Module({
  imports: [RealtimeModule],
  controllers: [WalletController],
  providers: [WalletService, WalletAdjustmentsService],
  exports: [WalletService, WalletAdjustmentsService],
})
export class WalletModule {}
