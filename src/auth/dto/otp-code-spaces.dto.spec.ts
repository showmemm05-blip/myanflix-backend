import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ResetPasswordDto } from './reset-password.dto';
import { VerifyOtpDto } from './verify-otp.dto';

/**
 * The SMS shows the code as "MyanFlix: 482 913", so a pasted code can carry
 * the space. Both code-checking bodies strip whitespace before the 6-character
 * rule runs — through the SAME ValidationPipe options AppModule registers.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (metatype: new () => object, body: unknown) =>
  pipe.transform(body, { type: 'body', metatype });

describe('OTP code with a space (SMS shows "482 913")', () => {
  it('VerifyOtpDto accepts "482 913" as 482913', async () => {
    const dto = (await validate(VerifyOtpDto, {
      phone: '+959123456789',
      code: '482 913',
    })) as VerifyOtpDto;
    expect(dto.code).toBe('482913');
  });

  it('ResetPasswordDto accepts " 482 913 " as 482913', async () => {
    const dto = (await validate(ResetPasswordDto, {
      phone: '+959123456789',
      code: ' 482 913 ',
      newPassword: 'a-long-enough-password',
    })) as ResetPasswordDto;
    expect(dto.code).toBe('482913');
  });

  it('still refuses a code that is not 6 characters after the spaces go', async () => {
    await expect(
      validate(VerifyOtpDto, { phone: '+959123456789', code: '482 91' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
