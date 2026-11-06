import { HttpStatus } from '@nestjs/common';
import {
  CodedHttpException,
  type CodedErrorExtra,
} from '../common/errors/coded-http.exception';

/**
 * Error codes a client can branch on; the message is for people. The AD_*
 * codes are the admin form's (ads-admin.service.ts and ad-video.service.ts),
 * AD_PLAYBACK_NOT_FOUND is the player's, the ANALYTICS codes mirror the
 * lottery's so the admin's period picker can share one error map.
 */
export const ADS_ERRORS = {
  NOT_FOUND: 'AD_NOT_FOUND',
  TITLE_REQUIRED: 'AD_TITLE_REQUIRED',
  /** 400: the end is not after the start. */
  WINDOW_INVALID: 'AD_WINDOW_INVALID',
  /** 400: one daily hour without the other, or the same hour twice. */
  DAILY_WINDOW_INVALID: 'AD_DAILY_WINDOW_INVALID',
  /** 400: SELECTED with no movie. */
  TARGET_MOVIES_REQUIRED: 'AD_TARGET_MOVIES_REQUIRED',
  /** 400: a selected movie does not exist; details.movieIds lists them. */
  TARGET_MOVIE_NOT_FOUND: 'AD_TARGET_MOVIE_NOT_FOUND',
  /** 400: skippable without a skip-after second. */
  SKIP_AFTER_REQUIRED: 'AD_SKIP_AFTER_REQUIRED',
  /** 400 / 409 (attach): skip-after is not shorter than the video. */
  SKIP_AFTER_TOO_LONG: 'AD_SKIP_AFTER_TOO_LONG',
  /** 400: switching on an ad that has no video. */
  VIDEO_REQUIRED: 'AD_VIDEO_REQUIRED',
  /** 404 (attach): nothing was uploaded to the staging key. */
  VIDEO_MISSING: 'AD_VIDEO_MISSING',
  /** 409 (attach): another attach landed on this ad meanwhile; upload and attach again. */
  VIDEO_ATTACH_CONFLICT: 'AD_VIDEO_ATTACH_CONFLICT',
  /** 400 (attach): the uploaded bytes are not an MP4 container. */
  VIDEO_NOT_MP4: 'AD_VIDEO_NOT_MP4',
  /** 400 (attach): over UPLOAD_MAX_AD_VIDEO_BYTES; details { bytes, maxBytes }. */
  VIDEO_TOO_LARGE: 'AD_VIDEO_TOO_LARGE',
  /** 400 (attach): longer than AD_MAX_DURATION_SECONDS; details { durationSeconds, maxSeconds }. */
  VIDEO_TOO_LONG: 'AD_VIDEO_TOO_LONG',
  /** 400 (attach): ffprobe could not read it, or it has no video stream. */
  VIDEO_UNREADABLE: 'AD_VIDEO_UNREADABLE',
  /** 400: a field (or route) of the other ad type — a video field on a corner picture or the reverse. */
  FORMAT_MISMATCH: 'AD_FORMAT_MISMATCH',
  /** 400: a video ad that plays neither before the movie nor at breaks. */
  SLOTS_REQUIRED: 'AD_SLOTS_REQUIRED',
  /** 400: switching on a corner ad that has no picture. */
  IMAGE_REQUIRED: 'AD_IMAGE_REQUIRED',
  /** 413 (image): over AD_LIMITS.imageBytes; details { bytes, maxBytes }. */
  IMAGE_TOO_LARGE: 'AD_IMAGE_TOO_LARGE',
  /** 400 (image): not a PNG / JPEG / WebP / GIF, or no file. */
  IMAGE_UNSUPPORTED: 'AD_IMAGE_UNSUPPORTED',
  /** 400 (image): a side under 16 px, or longer than 8:1; details { width, height }. */
  IMAGE_SHAPE_INVALID: 'AD_IMAGE_SHAPE_INVALID',
  /** 400: corner timing that cannot work (comes back before it left, or "until closed" that repeats). */
  CORNER_TIMING_INVALID: 'AD_CORNER_TIMING_INVALID',
  /** 400: the link is not a full http(s) web address. */
  LINK_INVALID: 'AD_LINK_INVALID',
  /** 404: the playback id is unknown, or belongs to another viewer. */
  PLAYBACK_NOT_FOUND: 'AD_PLAYBACK_NOT_FOUND',
  /** 400 (analytics): `from` after `to`, one without the other, or not a calendar day. */
  ANALYTICS_RANGE_INVALID: 'AD_ANALYTICS_RANGE_INVALID',
  /** 400 (analytics): the period spans more than 366 days; details { days, maxDays }. */
  ANALYTICS_RANGE_TOO_LONG: 'AD_ANALYTICS_RANGE_TOO_LONG',
} as const;

export const adError = (
  status: HttpStatus,
  code: string,
  message: string,
  extra?: CodedErrorExtra,
) => new CodedHttpException(status, code, message, extra);

export const adBadRequest = (
  code: string,
  message: string,
  extra?: CodedErrorExtra,
) => adError(HttpStatus.BAD_REQUEST, code, message, extra);
