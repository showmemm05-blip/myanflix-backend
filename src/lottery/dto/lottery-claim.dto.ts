import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CLAIM_LIST_STATUS_WIRE,
  CLAIM_REJECT_REASON_WIRE,
  type ClaimListStatusWire,
  type ClaimRejectReasonWire,
} from '../claims/claim-status';
import { DRAW_PAGE_SIZE_DEFAULT, DRAW_PAGE_SIZE_MAX } from './lottery-draw.dto';
import { trimmedOrNull } from './lottery-dream.dto';

/** The admin "Prize claims" table pages 25 at a time, at most 100. */
export const CLAIMS_PAGE_SIZE_DEFAULT = 25;
export const CLAIMS_PAGE_SIZE_MAX = 100;
/** The rejection note's column is VARCHAR(300). */
export const CLAIM_NOTE_MAX = 300;

const SEARCH_MAX = 100;

/** POST /lottery/claims { drawNo } — the customer asks to be paid everything they won in that draw. */
export class RequestClaimDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  drawNo!: number;
}

/** GET /lottery/claims?page&pageSize — the caller's own claims, newest first. */
export class MyClaimsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DRAW_PAGE_SIZE_MAX)
  pageSize?: number = DRAW_PAGE_SIZE_DEFAULT;
}

/**
 * GET /lottery/admin/claims?status&drawId&q&page&pageSize — one tab of the
 * admin page. `status` defaults to the waiting list; `q` finds a ticket
 * number or a lottery number by prefix, or the customer by username,
 * display name or phone.
 */
export class AdminClaimsQueryDto {
  @IsOptional()
  @IsIn(CLAIM_LIST_STATUS_WIRE)
  status?: ClaimListStatusWire = 'requested';

  @IsOptional()
  @IsUUID()
  drawId?: string;

  @Transform(({ value }: { value: unknown }) => trimmedOrNull(value))
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  q?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLAIMS_PAGE_SIZE_MAX)
  pageSize?: number = CLAIMS_PAGE_SIZE_DEFAULT;
}

/** GET /lottery/admin/claims/summary?drawId — the four tiles, for every draw or one. */
export class AdminClaimsSummaryQueryDto {
  @IsOptional()
  @IsUUID()
  drawId?: string;
}

/**
 * POST /lottery/admin/claims/:id/reject { reason, note? } — the preset
 * reason the customer sees, plus a note of up to 300 characters that is
 * REQUIRED when the reason is "other" (a blank note reads as none).
 */
export class RejectClaimDto {
  @IsIn(CLAIM_REJECT_REASON_WIRE)
  reason!: ClaimRejectReasonWire;

  @Transform(({ value }: { value: unknown }) => trimmedOrNull(value))
  @ValidateIf(
    (dto: RejectClaimDto) =>
      dto.reason === 'other' || (dto.note !== undefined && dto.note !== null),
  )
  @IsString({ message: 'note is required when the reason is "other"' })
  @MaxLength(CLAIM_NOTE_MAX)
  note?: string | null;
}
