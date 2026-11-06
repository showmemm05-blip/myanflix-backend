import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import { isOwnUploadedImageUrl } from '../../payment-accounts/dto/create-payment-method-type.dto';
import { DREAM_BOOK_WIRE, type DreamBookWire } from '../dream-book';

/**
 * Field limits, shared with the service, the import and the specs. Burmese
 * needs more UTF-16 units than English for the same words, so the name
 * limit is generous for a one-line label.
 */
export const LOTTERY_DREAM_LIMITS = {
  name: 120,
  pictureUrl: 1000,
  search: 100,
} as const;

/** The admin list's to-do filters; `all` (or none) is every row. */
export const DREAM_ADMIN_FILTERS = [
  'all',
  'missing_name',
  'missing_picture',
  'inactive',
] as const;

export type DreamAdminFilter = (typeof DREAM_ADMIN_FILTERS)[number];

export const DREAM_PAGE_SIZE_DEFAULT = 50;
export const DREAM_PAGE_SIZE_MAX = 100;

/** Trims, and turns a blank string into null ("clear this field"). Shared with the draw DTOs. */
export const trimmedOrNull = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

/** An optional text: absent = keep, null or '' = clear. */
function OptionalText(max: number) {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(max),
  );
}

/**
 * The same rule as a home promo's image (and a payment-method logo, I-15):
 * the URL of an image that POST /uploads/image stored for us —
 * `<host>/<bucket>/images/<purpose>/<file>`. The dream books are open to
 * guests, so an off-site address could serve a tracking pixel to everyone.
 * Shared with the draw DTOs (a draw's picture is public too).
 */
export function IsOwnUploadedImageUrl(options?: ValidationOptions) {
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
    MaxLength(LOTTERY_DREAM_LIMITS.pictureUrl),
    IsOwnUploadedImageUrl(),
  );
}

/** `q`: a name fragment or the start of a number; blank = no search. */
function OptionalSearch() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(LOTTERY_DREAM_LIMITS.search),
  );
}

/** GET /lottery/dreams?book=1000|100&q= — one book at a time, like the apps browse. */
export class DreamQueryDto {
  @IsIn(DREAM_BOOK_WIRE)
  book!: DreamBookWire;

  @OptionalSearch()
  q?: string | null;
}

/**
 * GET /lottery/admin/dreams. No book = both books (1000 first). `page` and
 * `pageSize` carry defaults on purpose — they are wanted on a GET and
 * nothing PartialTypes this class.
 */
export class AdminDreamQueryDto {
  @IsOptional()
  @IsIn(DREAM_BOOK_WIRE)
  book?: DreamBookWire;

  @OptionalSearch()
  q?: string | null;

  @IsOptional()
  @IsIn(DREAM_ADMIN_FILTERS)
  filter?: DreamAdminFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DREAM_PAGE_SIZE_MAX)
  pageSize?: number = DREAM_PAGE_SIZE_DEFAULT;
}

/**
 * PATCH /lottery/admin/dreams/:id — every field optional; absent = keep,
 * null / '' = clear. No class-property initializers (F-002). The book and
 * the number never change: a dream IS its number.
 */
export class UpdateLotteryDreamDto {
  @OptionalText(LOTTERY_DREAM_LIMITS.name)
  nameEn?: string | null;

  @OptionalText(LOTTERY_DREAM_LIMITS.name)
  nameMy?: string | null;

  @OptionalOwnImageUrl()
  pictureUrl?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}

/** POST /lottery/admin/dreams/import?dryRun=true — a preview that writes nothing. */
export class ImportDreamsQueryDto {
  @ValidateIf((_, value) => value !== undefined)
  @ToBoolean()
  @IsBoolean()
  dryRun?: boolean;
}

/** GET /lottery/admin/dreams/export?book=1000|100 — one book per file. */
export class ExportDreamsQueryDto {
  @IsIn(DREAM_BOOK_WIRE)
  book!: DreamBookWire;
}
