import { IsIn } from 'class-validator';
import {
  IMAGE_PURPOSES,
  type ImagePurpose,
} from '../../common/storage/media-taxonomy';

/**
 * The text half of POST /uploads/image — multer puts a multipart form's
 * non-file fields on req.body, so the global ValidationPipe validates this
 * exactly like a JSON body.
 *
 * `purpose` is REQUIRED and has no fallback: it decides which folder under
 * images/ the object lands in, and a mis-foldered image is invisible to
 * every cleanup path that works by prefix. So a missing or unknown value is
 * a 400 that spells out what the caller may send, rather than a silent
 * landing in images/other/ that nobody would ever notice.
 *
 * The accepted values come from the media taxonomy registry, which is also
 * what names the folders — the route and the layout cannot drift apart.
 */
export class UploadImageDto {
  @IsIn(IMAGE_PURPOSES, {
    message: `purpose is required and must be one of: ${IMAGE_PURPOSES.join(', ')}`,
  })
  purpose!: ImagePurpose;
}
