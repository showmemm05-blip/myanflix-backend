import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RequestOtpDto } from './request-otp.dto';

/**
 * POST /auth/otp/request through the SAME ValidationPipe options AppModule
 * registers (whitelist + forbidNonWhitelisted + implicit conversion): the
 * clients that send only `{ phone }` must keep working, and `purpose` (B1)
 * accepts exactly the two documented values.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: RequestOtpDto,
  }) as Promise<RequestOtpDto>;

describe('RequestOtpDto under the global ValidationPipe', () => {
  it('accepts `{ phone }` alone — purpose is optional (sign-in)', async () => {
    const dto = await validate({ phone: '09123456789' });
    expect(dto.phone).toBe('+959123456789');
    expect(dto.purpose).toBeUndefined();
  });

  it.each(['login', 'password_reset'])(
    'accepts purpose %p',
    async (purpose) => {
      const dto = await validate({ phone: '+959123456789', purpose });
      expect(dto.purpose).toBe(purpose);
    },
  );

  it.each(['reset', 'LOGIN', 'PASSWORD_RESET', '', 1])(
    'refuses purpose %p',
    async (purpose) => {
      await expect(
        validate({ phone: '+959123456789', purpose }),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('still refuses any other key', async () => {
    await expect(
      validate({ phone: '+959123456789', channel: 'sms' }),
    ).rejects.toThrow(BadRequestException);
  });
});
