/**
 * Still-image type detection from the bytes themselves.
 *
 * Both the multipart Content-Type header and the client's filename are
 * attacker-controlled, so neither may decide what an uploaded file is or
 * which extension it is stored under. The magic bytes at the start of the
 * file do: every format accepted here carries a fixed signature at offset
 * 0, and anything without one — a PDF, an SVG or an HTML page renamed to
 * .png, a file cut short before its signature is complete — is simply not
 * an image as far as the server is concerned.
 *
 * Shared by the avatar route (UsersService.uploadAvatar: the declared MIME
 * must match the bytes) and the staff image route (UploadsService.saveImage:
 * the type is read from the bytes alone, and nothing reaches sharp before
 * it passed here — SEC-008 / SEC-019).
 */

/** The still-image types the server stores at all, in sniffing order. */
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/**
 * File extension per VALIDATED MIME type — never from the client-supplied
 * filename. The leading dot is part of the value because that is the form
 * every StorageService key builder takes (extname()'s form), so nothing
 * has to re-add it.
 */
export const IMAGE_MIME_TO_EXTENSION: Record<ImageMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * True when `buffer` starts with the signature of `mimetype`. A type this
 * module does not know never matches, and a buffer shorter than the
 * signature never matches either (a truncated header is not a header).
 */
export function matchesMagicBytes(mimetype: string, buffer: Buffer): boolean {
  switch (mimetype) {
    case 'image/jpeg':
      return (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      );
    case 'image/png':
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
    case 'image/webp':
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    case 'image/gif': {
      const header =
        buffer.length >= 6 ? buffer.subarray(0, 6).toString('latin1') : '';
      return header === 'GIF87a' || header === 'GIF89a';
    }
    default:
      return false;
  }
}

/** What the bytes say a file is, and the extension it must be stored under. */
export interface SniffedImageType {
  mimetype: ImageMimeType;
  extension: string;
}

/**
 * Reads the type off the first bytes alone. Null for anything that is not
 * one of IMAGE_MIME_TYPES — the caller refuses the upload, it never guesses.
 */
export function sniffImageType(buffer: Buffer): SniffedImageType | null {
  for (const mimetype of IMAGE_MIME_TYPES) {
    if (matchesMagicBytes(mimetype, buffer)) {
      return { mimetype, extension: IMAGE_MIME_TO_EXTENSION[mimetype] };
    }
  }
  return null;
}
