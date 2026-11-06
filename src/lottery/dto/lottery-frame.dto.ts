import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import type { ImagePurpose } from '../../common/storage/media-taxonomy';
import { ownUploadedImagePurpose } from '../../payment-accounts/dto/create-payment-method-type.dto';
import { LOTTERY_DREAM_LIMITS, trimmedOrNull } from './lottery-dream.dto';

/**
 * The ticket frame (ticket frame, 2026-10-19): the printed background every
 * ticket of a draw is drawn on, uploaded once in Lottery > Settings with
 * this purpose and copied into each new draw. The layout never changes —
 * only the artwork does — so the apps place every text layer by the same
 * template fractions whichever frame a draw carries.
 */
export const LOTTERY_FRAME_PURPOSE = 'lottery_frame' satisfies ImagePurpose;

/** True only for the URL of an upload that landed in images/lottery_frame/. */
export function isOwnLotteryFrameUrl(value: unknown): boolean {
  return ownUploadedImagePurpose(value) === LOTTERY_FRAME_PURPOSE;
}

/**
 * Stricter than IsOwnUploadedImageUrl: the upload must sit in the frame
 * folder. A dream or draw picture is ours too, but it is the wrong shape
 * and the wrong size for a frame, and the admin picks the purpose per
 * upload button, so a picture arriving here is a client mix-up to refuse.
 */
export function IsOwnLotteryFrameUrl(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isOwnLotteryFrameUrl',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return isOwnLotteryFrameUrl(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be the URL of a frame uploaded through POST /uploads/image with purpose ${LOTTERY_FRAME_PURPOSE}`;
        },
      },
    });
}

/** An optional frame: absent = keep, null or '' = the built-in frame, else one of our own frame uploads. */
export function OptionalOwnFrameUrl() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => trimmedOrNull(value)),
    IsOptional(),
    IsString(),
    MaxLength(LOTTERY_DREAM_LIMITS.pictureUrl),
    IsOwnLotteryFrameUrl(),
  );
}
