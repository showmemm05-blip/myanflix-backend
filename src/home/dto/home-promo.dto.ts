import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import {
  HomePromoArtPreset,
  HomePromoCtaTarget,
  HomePromoKind,
} from '../../generated/prisma/client';
import { isOwnUploadedImageUrl } from '../../payment-accounts/dto/create-payment-method-type.dto';

/**
 * Field limits, shared with the service and the specs. Burmese text needs
 * more UTF-16 units than English for the same words (stacked consonants and
 * vowel signs are separate code points), so the limits are generous.
 */
export const HOME_PROMO_LIMITS = {
  title: 120,
  kicker: 80,
  body: 400,
  ctaLabel: 40,
  url: 500,
  imageUrl: 1000,
  dateText: 40,
} as const;

/** The most promos one kind may hold — a carousel of 30 slides is already absurd. */
export const HOME_PROMOS_PER_KIND_MAX = 30;

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

/** http(s) only, LAN hosts allowed (no TLD needed), bounded length. */
export function OptionalHttpUrl(max: number) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(max),
    IsUrl({
      protocols: ['http', 'https'],
      require_protocol: true,
      require_tld: false,
    }),
  );
}

/**
 * The same rule as a payment-method logo (I-15): the URL of an image that
 * POST /uploads/image stored for us — `<host>/<bucket>/images/<purpose>/<file>`.
 * An off-site address could otherwise serve a tracking pixel to every
 * visitor of the home page, guests included.
 */
function IsOwnUploadedImageUrl(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isOwnUploadedImageUrl',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return isOwnUploadedImageUrl(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be the URL of an image uploaded through POST /uploads/image`;
        },
      },
    });
}

function OptionalOwnImageUrl() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(HOME_PROMO_LIMITS.imageUrl),
    IsOwnUploadedImageUrl(),
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

/**
 * POST /home/promos. No class-property initializers on purpose (F-002):
 * create-time defaults (ctaTarget NONE, artPreset GENERIC, isActive true,
 * sortOrder = end of its kind) live in the schema and in
 * HomePromosService.create. Cross-field rules (a title target needs a
 * targetId, URL needs url, English/Burmese pairs, the time window) are
 * checked in the service, where the stored row and the patch are merged.
 */
export class CreateHomePromoDto {
  @IsEnum(HomePromoKind)
  kind!: HomePromoKind;

  @RequiredText(HOME_PROMO_LIMITS.title)
  titleEn!: string;

  @RequiredText(HOME_PROMO_LIMITS.title)
  titleMm!: string;

  @OptionalText(HOME_PROMO_LIMITS.kicker)
  kickerEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.kicker)
  kickerMm?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.body)
  bodyEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.body)
  bodyMm?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.ctaLabel)
  ctaLabelEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.ctaLabel)
  ctaLabelMm?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(HomePromoCtaTarget)
  ctaTarget?: HomePromoCtaTarget;

  @IsOptional()
  @IsUUID('all')
  targetId?: string | null;

  @OptionalHttpUrl(HOME_PROMO_LIMITS.url)
  url?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(HomePromoArtPreset)
  artPreset?: HomePromoArtPreset;

  @OptionalOwnImageUrl()
  imageUrl?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.dateText)
  dateText?: string | null;

  @OptionalTimestamp()
  startsAt?: string | null;

  @OptionalTimestamp()
  endsAt?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * PATCH /home/promos/:id — every field optional, written out by hand rather
 * than PartialType so the not-nullable fields (titles, ctaTarget, artPreset,
 * isActive) answer an explicit null with a 400 instead of passing it to
 * Prisma. `kind` cannot change: a promo belongs to one list for life
 * (delete and re-create to move it). Absent = keep; null / '' = clear.
 */
export class UpdateHomePromoDto {
  @KeepOrText(HOME_PROMO_LIMITS.title)
  titleEn?: string;

  @KeepOrText(HOME_PROMO_LIMITS.title)
  titleMm?: string;

  @OptionalText(HOME_PROMO_LIMITS.kicker)
  kickerEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.kicker)
  kickerMm?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.body)
  bodyEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.body)
  bodyMm?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.ctaLabel)
  ctaLabelEn?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.ctaLabel)
  ctaLabelMm?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(HomePromoCtaTarget)
  ctaTarget?: HomePromoCtaTarget;

  @IsOptional()
  @IsUUID('all')
  targetId?: string | null;

  @OptionalHttpUrl(HOME_PROMO_LIMITS.url)
  url?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(HomePromoArtPreset)
  artPreset?: HomePromoArtPreset;

  @OptionalOwnImageUrl()
  imageUrl?: string | null;

  @OptionalText(HOME_PROMO_LIMITS.dateText)
  dateText?: string | null;

  @OptionalTimestamp()
  startsAt?: string | null;

  @OptionalTimestamp()
  endsAt?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * PATCH /home/promos/reorder — the complete new order of ONE kind: `ids`
 * must name every promo of that kind exactly once (the service refuses a
 * partial list, so two admins dragging at once cannot silently interleave).
 */
export class ReorderHomePromosDto {
  @IsEnum(HomePromoKind)
  kind!: HomePromoKind;

  @IsArray()
  @ArrayMaxSize(HOME_PROMOS_PER_KIND_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

/** GET /home/promos?kind=HERO — no kind = every promo. */
export class HomePromoQueryDto {
  @IsOptional()
  @IsEnum(HomePromoKind)
  kind?: HomePromoKind;
}
