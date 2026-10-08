import { Module } from '@nestjs/common';
import { SmsGatewayModule } from '../sms-gateway/sms-gateway.module';
import { SmsService } from './sms.service';

@Module({
  imports: [SmsGatewayModule],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
