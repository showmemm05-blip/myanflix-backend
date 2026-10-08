import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  REPORTABLE_SMS_STATUSES,
  type ReportableSmsStatus,
} from '../sms-transitions';

/**
 * POST /sms-gateway/device/jobs/:id/result — what happened to one leased
 * SMS, as the phone's sent / delivery receivers recorded it. `occurredAt`
 * is the phone's clock (a future time is stored as the server's "now").
 */
export class JobResultDto {
  @IsIn(REPORTABLE_SMS_STATUSES, {
    message: `status must be one of: ${REPORTABLE_SMS_STATUSES.join(', ')}`,
  })
  status!: ReportableSmsStatus;

  /** e.g. "RESULT_ERROR_NO_SERVICE", "expired". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  errorCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  errorMessage?: string | null;

  @IsISO8601({ strict: true })
  occurredAt!: string;
}
