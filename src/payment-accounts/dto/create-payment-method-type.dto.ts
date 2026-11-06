import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { ToBoolean } from '../../common/decorators/to-boolean.decorator';
import {
  isImagePurpose,
  type ImagePurpose,
} from '../../common/storage/media-taxonomy';

/**
 * Same resolution as MinioService (`MINIO_BUCKET`, default 'movies'). Read
 * at validation time — ConfigModule has copied the validated env, default
 * included, into process.env long before the first request is validated.
 */
function ownBucket(): string {
  return process.env.MINIO_BUCKET || 'movies';
}

/**
 * True only for the URL of an image uploaded through POST /uploads/image:
 * `<http(s) host>/<bucket>/images/<purpose>/<file>`. The host is ignored on
 * purpose (a stale LAN IP is still ours — MinioService.ownImageKey repairs
 * it); the path must be ours, so a well-formed off-site address such as
 * `https://evil.example/beacon.gif` can no longer be stored and served to
 * every user picking a payment method (I-15). Anything that passes here is
 * rewritten by canonicalImageUrl() onto our own storage before it is saved.
 */
export function isOwnUploadedImageUrl(value: unknown): boolean {
  return ownUploadedImagePurpose(value) !== null;
}

/**
 * The purpose folder (`images/<purpose>/`) of one of our own uploaded
 * images, or null when the value is not such a URL. The same rule as
 * isOwnUploadedImageUrl, kept apart so a field that must hold ONE kind of
 * upload (a lottery ticket frame, never a dream picture) can say which.
 */
export function ownUploadedImagePurpose(value: unknown): ImagePurpose | null {
  if (typeof value !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const [bucket, folder, purpose, file, ...rest] = parsed.pathname
    .split('/')
    .filter(Boolean);
  return rest.length === 0 &&
    bucket === ownBucket() &&
    folder === 'images' &&
    isImagePurpose(purpose) &&
    typeof file === 'string' &&
    file.length > 0
    ? purpose
    : null;
}

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

export class CreatePaymentMethodTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  label!: string;

  /**
   * Create-time default is `?? false` in PaymentAccountsService.createType
   * (and Prisma `@default(false)`). No class initializer on purpose:
   * UpdatePaymentMethodTypeDto = PartialType(CreatePaymentMethodTypeDto)
   * inherits initializers and the global transform pipe (src/app.module.ts)
   * would inject `false` into every PATCH that omits the field. Precedent:
   * src/subscriptions/dto/create-plan.dto.ts.
   */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  requiresBankName?: boolean;

  /**
   * A full URL like every other image field (movies/series posterUrl), and
   * additionally one of OUR uploaded images — the admin only ever sends the
   * absolute URL returned by POST /uploads/image (or the one it read back,
   * which is the same object re-hosted), or null/undefined to clear or keep
   * the logo (I-15).
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @IsOwnUploadedImageUrl()
  logoUrl?: string;
}
