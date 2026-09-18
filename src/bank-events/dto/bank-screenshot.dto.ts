import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { IDEMPOTENCY_KEY_PATTERN } from './bank-event-batch.dto';

/**
 * Text fields of the multipart screenshot upload (the `file` part is read
 * by the FileInterceptor, not validated here). The idempotency key must be
 * the one the event that MATCHED the row carried — the service refuses to
 * attach a screenshot to a row the event did not match.
 */
export class BankScreenshotDto {
  @Matches(IDEMPOTENCY_KEY_PATTERN, {
    message: 'idempotencyKey must be a 64-char lowercase sha256 hex',
  })
  idempotencyKey!: string;

  /** For the audit row only — which phone the picture came from. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  deviceSerial?: string;
}
