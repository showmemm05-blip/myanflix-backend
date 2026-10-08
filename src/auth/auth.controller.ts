import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { ThrottleAuth } from '../common/throttling/throttling.config';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { CheckPhoneDto } from './dto/check-phone.dto';
import { VerifyPhonePasswordDto } from './dto/verify-phone-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

/**
 * M-20: there is deliberately no POST /auth/register. Customers sign up by
 * phone + code (POST /auth/otp/verify) or Google; staff accounts are created
 * by other staff (POST /staff). A public username+password sign-up let
 * anyone pre-claim the `user_<digits>` name a phone sign-up needs and mint
 * unverified accounts; no client ever called it.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @ThrottleAuth('credential')
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @ThrottleAuth('credential')
  @HttpCode(HttpStatus.OK)
  @Post('phone/check')
  checkPhone(@Body() dto: CheckPhoneDto) {
    return this.authService.checkPhoneExists(dto.phone);
  }

  @Public()
  @ThrottleAuth('credential')
  @HttpCode(HttpStatus.OK)
  @Post('phone/verify-password')
  verifyPhonePassword(@Body() dto: VerifyPhonePasswordDto) {
    return this.authService.verifyPhonePassword(dto.phone, dto.password);
  }

  @Public()
  @ThrottleAuth('otpRequest')
  @HttpCode(HttpStatus.OK)
  @Post('otp/request')
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.authService.requestPhoneOtp(dto.phone, dto.purpose);
    return { sent: true };
  }

  @Public()
  @ThrottleAuth('credential')
  @HttpCode(HttpStatus.OK)
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyPhoneOtp(
      dto.phone,
      dto.code,
      dto.password,
      dto.stepToken,
    );
  }

  /**
   * H-8 "forgot password": the code comes from POST /auth/otp/request with
   * `purpose: 'password_reset'` (B1: a sign-in code never works here).
   * Throttled like /auth/otp/verify — it answers "is this code right?" just
   * the same.
   */
  @Public()
  @ThrottleAuth('credential')
  @HttpCode(HttpStatus.OK)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPasswordWithOtp(
      dto.phone,
      dto.code,
      dto.newPassword,
    );
  }

  @Public()
  @ThrottleAuth('session')
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @ThrottleAuth('session')
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto.refreshToken);
    return { loggedOut: true };
  }
}
