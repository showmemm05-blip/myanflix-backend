import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import {
  AdvertisementFormat,
  AdvertisementTargetType,
} from '../../generated/prisma/client';

/**
 * Field limits, shared with the service, the specs and the admin form.
 * Burmese text needs more UTF-16 units than English for the same words, so
 * the text limits are generous.
 */
export const AD_LIMITS = {
  title: 120,
  description: 1000,
  /** How many titles one SELECTED ad may list. */
  movies: 500,
  priority: { min: 0, max: 1000 },
  skipAfterSeconds: { min: 1, max: 600 },
  frequencyLimitMinutes: { min: 1, max: 10080 },
  maxImpressionsPerUserPerDay: { min: 1, max: 100 },
  /** UTC-12 .. UTC+14, the real range of the world's offsets. */
  tzOffsetMinutes: { min: -720, max: 840 },
  /** What the attach step accepts: one second to ten minutes. */
  durationSeconds: { min: 1, max: 600 },
  /** A corner picture's link. */
  linkUrl: 500,
  /** Seconds a corner picture stays up per showing (null = until closed). */
  cornerShowSeconds: { min: 3, max: 600 },
  /** Minutes watched before a corner picture comes back (null = once). */
  cornerRepeatMinutes: { min: 1, max: 240 },
  /** A corner picture's file: 3 MB, sides ≥ 16 px, at most 8:1. */
  imageBytes: 3 * 1024 * 1024,
  imageMinSide: 16,
  imageMaxAspect: 8,
  /** Still pictures wider than this are scaled down (GIF / animated WebP never). */
  imageMaxWidth: 960,
} as const;

/** A new corner picture shows this long per showing unless the form says otherwise. */
export const DEFAULT_CORNER_SHOW_SECONDS = 10;

/** The live states the admin list can filter on (AdsAdminService.adLiveStateOf). */
export const AD_LIVE_STATES = [
  'LIVE',
  'SCHEDULED',
  'ENDED',
  'OFF',
  'NO_VIDEO',
] as const;
export type AdLiveState = (typeof AD_LIVE_STATES)[number];

/** "HH:mm", 24-hour. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const ADMIN_LIST_PAGE_SIZE_MAX = 100;
const SEARCH_MAX = 100;

/** Trims strings; anything else is left for the validators to judge. */
const trimmed = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;

/** Trims, and turns a blank string into null ("clear this field"). */
const trimmedOrNull = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

/** A required one-line text. */
function RequiredText(max: number) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmed(value)),
    IsString(),
    IsNotEmpty(),
    MaxLength(max),
  );
}

/**
 * A required text on an UPDATE: absent = keep, but an explicit null (or a
 * blank) is a 400 — IsOptional would wave null through to the database.
 */
function KeepOrText(max: number) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmed(value)),
    ValidateIf((_, value) => value !== undefined),
    IsString(),
    IsNotEmpty(),
    MaxLength(max),
  );
}

/** An optional text: absent = keep (update) / unset (create), null or '' = clear. */
function OptionalText(max: number) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(max),
  );
}

/** An optional ISO-8601 timestamp; null or '' clears it. */
function OptionalTimestamp() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsISO8601({ strict: true }),
  );
}

/** An optional "HH:mm" hour of the day; null or '' clears it. */
function OptionalTimeOfDay() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    Matches(TIME_OF_DAY_PATTERN, {
      message: '$property must be a time of day written HH:mm',
    }),
  );
}

/**
 * An optional whole number inside [min, max]; null or '' clears it. The
 * global ValidationPipe's implicit conversion already turns "30" into 30
 * and leaves null alone, so only the blank string needs a hand.
 */
function OptionalBoundedInt(bounds: { min: number; max: number }) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => (value === '' ? null : value)),
    IsOptional(),
    IsInt(),
    Min(bounds.min),
    Max(bounds.max),
  );
}

function OptionalFlag() {
  return applyDecorators(
    ValidateIf((_, value) => value !== undefined),
    ToBoolean(),
    IsBoolean(),
  );
}

function OptionalMovieIds() {
  return applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayUnique(),
    ArrayMaxSize(AD_LIMITS.movies),
    IsUUID('all', { each: true }),
  );
}

/**
 * POST /ads/admin. No class-property initializers on purpose (F-002): the
 * create-time defaults (isActive false until a video is attached, target
 * ALL, priority 0, not skippable, Myanmar offset) live in the schema and in
 * AdsAdminService.create. Cross-field rules (end after start, both daily
 * hours or neither, SELECTED needs movies that exist, skippable needs a
 * skip-after second shorter than the video, ON needs a video) are checked
 * in the service, where the stored row and the patch are merged.
 */
export class CreateAdvertisementDto {
  @RequiredText(AD_LIMITS.title)
  title!: string;

  @OptionalText(AD_LIMITS.description)
  description?: string | null;

  @OptionalFlag()
  isActive?: boolean;

  @OptionalTimestamp()
  startsAt?: string | null;

  @OptionalTimestamp()
  endsAt?: string | null;

  @OptionalTimeOfDay()
  dailyStartTime?: string | null;

  @OptionalTimeOfDay()
  dailyEndTime?: string | null;

  @OptionalBoundedInt(AD_LIMITS.tzOffsetMinutes)
  tzOffsetMinutes?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(AdvertisementTargetType)
  targetType?: AdvertisementTargetType;

  @OptionalMovieIds()
  movieIds?: string[];

  @OptionalBoundedInt(AD_LIMITS.priority)
  priority?: number | null;

  @OptionalFlag()
  isSkippable?: boolean;

  @OptionalBoundedInt(AD_LIMITS.skipAfterSeconds)
  skipAfterSeconds?: number | null;

  @OptionalBoundedInt(AD_LIMITS.frequencyLimitMinutes)
  frequencyLimitMinutes?: number | null;

  @OptionalBoundedInt(AD_LIMITS.maxImpressionsPerUserPerDay)
  maxImpressionsPerUserPerDay?: number | null;

  /** VIDEO (default) or CORNER — fixed at creation, never on PATCH. */
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(AdvertisementFormat)
  format?: AdvertisementFormat;

  @OptionalFlag()
  playsBeforeMovie?: boolean;

  @OptionalFlag()
  playsAtBreaks?: boolean;

  @OptionalText(AD_LIMITS.linkUrl)
  linkUrl?: string | null;

  /** Absent on a new corner = DEFAULT_CORNER_SHOW_SECONDS; null = until closed. */
  @OptionalBoundedInt(AD_LIMITS.cornerShowSeconds)
  cornerShowSeconds?: number | null;

  @OptionalBoundedInt(AD_LIMITS.cornerRepeatMinutes)
  cornerRepeatMinutes?: number | null;

  @OptionalFlag()
  cornerClosable?: boolean;
}

/**
 * PATCH /ads/admin/:id — every field optional, written out by hand rather
 * than PartialType so the not-nullable fields (title, the flags, the
 * target type) answer an explicit null with a 400 instead of passing it to
 * Prisma. Absent = keep; null / '' = clear. `movieIds` replaces the whole
 * SELECTED list when present.
 */
export class UpdateAdvertisementDto {
  @KeepOrText(AD_LIMITS.title)
  title?: string;

  @OptionalText(AD_LIMITS.description)
  description?: string | null;

  @OptionalFlag()
  isActive?: boolean;

  @OptionalTimestamp()
  startsAt?: string | null;

  @OptionalTimestamp()
  endsAt?: string | null;

  @OptionalTimeOfDay()
  dailyStartTime?: string | null;

  @OptionalTimeOfDay()
  dailyEndTime?: string | null;

  @OptionalBoundedInt(AD_LIMITS.tzOffsetMinutes)
  tzOffsetMinutes?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(AdvertisementTargetType)
  targetType?: AdvertisementTargetType;

  @OptionalMovieIds()
  movieIds?: string[];

  @OptionalBoundedInt(AD_LIMITS.priority)
  priority?: number | null;

  @OptionalFlag()
  isSkippable?: boolean;

  @OptionalBoundedInt(AD_LIMITS.skipAfterSeconds)
  skipAfterSeconds?: number | null;

  @OptionalBoundedInt(AD_LIMITS.frequencyLimitMinutes)
  frequencyLimitMinutes?: number | null;

  @OptionalBoundedInt(AD_LIMITS.maxImpressionsPerUserPerDay)
  maxImpressionsPerUserPerDay?: number | null;

  // No `format`: the type is fixed at creation (the whitelist turns a
  // PATCH that sends it into a 400).

  @OptionalFlag()
  playsBeforeMovie?: boolean;

  @OptionalFlag()
  playsAtBreaks?: boolean;

  @OptionalText(AD_LIMITS.linkUrl)
  linkUrl?: string | null;

  /** null = until closed. */
  @OptionalBoundedInt(AD_LIMITS.cornerShowSeconds)
  cornerShowSeconds?: number | null;

  @OptionalBoundedInt(AD_LIMITS.cornerRepeatMinutes)
  cornerRepeatMinutes?: number | null;

  @OptionalFlag()
  cornerClosable?: boolean;
}

/** GET /ads/admin — newest first, 25 a page, searched by title, filtered by live state. */
export class AdminAdQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_LIST_PAGE_SIZE_MAX)
  limit?: number = 25;

  @Transform(
    ({ value }: { value: unknown }) => trimmedOrNull(value) ?? undefined,
  )
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  search?: string;

  @IsOptional()
  @IsIn(AD_LIVE_STATES)
  status?: AdLiveState;

  @IsOptional()
  @IsEnum(AdvertisementFormat)
  format?: AdvertisementFormat;
}

/**
 * POST /ads/admin/:id/video/attach — the admin says which staged file to
 * check and move. Today there is exactly one allowed name (video.mp4, the
 * "ad" upload type refuses anything else); it travels in the body so the
 * two sides keep naming the same file if that ever widens. The skip fields
 * are optional and land in the same transaction as the duration: a form
 * that lowers skip-after for a shorter video (or raises it for a longer
 * one) is checked against the NEW length, not the stored one.
 */
export class AttachAdVideoDto {
  @RequiredText(64)
  relativePath!: string;

  @OptionalFlag()
  isSkippable?: boolean;

  @OptionalBoundedInt(AD_LIMITS.skipAfterSeconds)
  skipAfterSeconds?: number | null;
}
