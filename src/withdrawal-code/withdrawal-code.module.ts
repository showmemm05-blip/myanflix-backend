import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OtpModule } from '../otp/otp.module';
import { WithdrawalCodeController } from './withdrawal-code.controller';
import { WithdrawalCodeService } from './withdrawal-code.service';

/**
 * The withdrawal code: the /users/me/withdrawal-code routes, and the
 * service WithdrawalsService asks before every withdrawal. PrismaService
 * and ConfigService are global.
 */
@Module({
  imports: [
    OtpModule,
    // The reset step token passes its own secret and expiry on every
    // sign/verify call (like AuthModule's), so this only makes JwtService
    // injectable.
    JwtModule.register({}),
  ],
  controllers: [WithdrawalCodeController],
  providers: [WithdrawalCodeService],
  exports: [WithdrawalCodeService],
})
export class WithdrawalCodeModule {}
