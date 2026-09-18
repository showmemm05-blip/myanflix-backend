import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const BANK_EVENT_DIRECTIONS = ['received', 'sent'] as const;
export type BankEventDirection = (typeof BANK_EVENT_DIRECTIONS)[number];

/** Batch cap — one phone-monitor tick posts at most this many outbox rows. */
export const MAX_BANK_EVENTS_PER_BATCH = 100;

/** sha256 hex — the phone-monitor's events.idempotency_key. */
export const IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * One bank notification as the phone-monitor captured it. The global
 * ValidationPipe runs with forbidNonWhitelisted, so any key not declared
 * here fails the WHOLE batch with 400 — the phone-monitor must send exactly
 * these keys and nothing else.
 */
export class BankEventDto {
  @Matches(IDEMPOTENCY_KEY_PATTERN, {
    message: 'idempotencyKey must be a 64-char lowercase sha256 hex',
  })
  idempotencyKey!: string;

  @IsString()
  @Length(1, 64)
  deviceSerial!: string;

  /** OUR PaymentAccount this phone belongs to — validated to exist and be active. */
  @IsUUID('4')
  paymentAccountId!: string;

  /** The phone-monitor never posts `unknown`; it fails those rows locally. */
  @IsIn(BANK_EVENT_DIRECTIONS)
  direction!: BankEventDirection;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  /** Anything but MMK (or absent) is rejected — every money field here is Kyat. */
  @IsOptional()
  @IsString()
  @Length(3, 8)
  currency?: string;

  /** The full code as printed (hyphens already stripped by the phone-monitor's parser). */
  @Matches(/^[A-Za-z0-9]{6,64}$/, {
    message: 'txCode must be 6–64 alphanumeric characters',
  })
  txCode!: string;

  /** Exactly as printed; the server re-derives it from txCode and rejects a mismatch. */
  @Matches(/^[A-Za-z0-9]{6}$/, {
    message: 'txCodeLast6 must be exactly 6 alphanumeric characters',
  })
  txCodeLast6!: string;

  @IsDateString()
  occurredAt!: string;

  /**
   * Accepted so a future admin view can use it, but NOT persisted anywhere
   * in this feature — there is no column for it and it can name
   * counterparties. The phone-monitor omits it by default.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notificationText?: string;
}

export class BankEventBatchDto {
  @ValidateNested({ each: true })
  @Type(() => BankEventDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BANK_EVENTS_PER_BATCH)
  events!: BankEventDto[];
}
