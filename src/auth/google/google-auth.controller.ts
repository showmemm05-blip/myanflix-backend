import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleAuth } from '../../common/throttling/throttling.config';
import { GoogleLoginDto } from './dto/google-login.dto';
import { GoogleAuthService } from './google-auth.service';

/**
 * POST /auth/google — lives beside AuthController under the same prefix so
 * that file (and every phone/staff route in it) stays byte-identical.
 */
@Controller('auth')
export class GoogleAuthController {
  constructor(private readonly googleAuthService: GoogleAuthService) {}

  @Public()
  @ThrottleAuth('session')
  @HttpCode(HttpStatus.OK)
  @Post('google')
  loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.googleAuthService.loginWithGoogle({
      credential: dto.credential,
      code: dto.code,
    });
  }
}
