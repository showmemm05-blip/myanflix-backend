import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';

/**
 * POST /sms-gateway/device/heartbeat — the gateway phone's health, every
 * 30 s. The global ValidationPipe runs with forbidNonWhitelisted, so the
 * phone must send exactly these keys. The nullable ones may be null (or
 * left out) when the phone cannot tell.
 */
export class DeviceHeartbeatDto {
  @IsString()
  @MaxLength(32)
  appVersion!: string;

  /** Battery percentage. */
  @IsInt()
  @Min(0)
  @Max(100)
  battery!: number;

  @ToBoolean()
  @IsBoolean()
  charging!: boolean;

  /** Android's 0-4 signal bars. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  signalLevel?: number | null;

  /** e.g. "LTE", "NR", "WIFI". */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  networkType?: string | null;

  /** The SIM's operator name, e.g. "ATOM", "MPT". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  simOperator?: string | null;

  /** Results stored on the phone but not yet acknowledged by this server. */
  @IsInt()
  @Min(0)
  pendingResults!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastError?: string | null;

  /**
   * The phone's own verdict: false while it cannot send an SMS (permission
   * missing, no SIM, no service, ...). The server then treats the gateway
   * as offline (codes get the 503) and leases it nothing. Optional: an app
   * that leaves it out counts as able.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  canSend?: boolean;

  /** Why canSend is false, e.g. "no_service", "sms_permission". */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  notReadyReason?: string | null;
}
