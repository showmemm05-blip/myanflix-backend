import { Injectable, Logger } from '@nestjs/common';

/**
 * No SMS provider is wired in yet — this is a stub so OtpService has
 * something to call today. The code itself is already persisted by
 * OtpService before this runs, so during testing it's read straight from
 * the `otp_codes` table instead of being delivered.
 *
 * Once a provider is chosen, replace the body of `send()` with the real
 * API call — every caller stays the same.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  async send(phone: string, message: string): Promise<void> {
    this.logger.log(`[SMS stub, not actually sent] to ${phone}: ${message}`);
  }
}
