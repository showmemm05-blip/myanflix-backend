import { Module } from '@nestjs/common';
import { DeviceTokenGuard } from './device-token.guard';
import { SmsDeviceBindingService } from './sms-device-binding.service';
import { SmsGatewayDeviceController } from './sms-gateway-device.controller';
import { SmsGatewayStatusController } from './sms-gateway-status.controller';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsJobWaiter } from './sms-job-waiter';
import { SmsSweeperService } from './sms-sweeper.service';

/**
 * The company-phone SMS gateway (SMS_PROVIDER=phone-gateway): the queue
 * SmsService writes to, the phone's device routes, the staff status card
 * and the 30 s sweeper. PrismaService is global; PermissionsGuard comes
 * from the global RolesModule, AuditService from the global AuditModule.
 */
@Module({
  controllers: [SmsGatewayDeviceController, SmsGatewayStatusController],
  providers: [
    SmsGatewayService,
    SmsJobWaiter,
    SmsSweeperService,
    SmsDeviceBindingService,
    DeviceTokenGuard,
  ],
  exports: [SmsGatewayService],
})
export class SmsGatewayModule {}
