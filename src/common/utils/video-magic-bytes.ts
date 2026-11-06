/**
 * The ISO base media file format header every MP4 / M4V / MOV starts with:
 * a 4-byte box size, then the box type `ftyp`. The brand that follows is
 * not checked — a QuickTime `qt  ` file is as playable in the apps as an
 * `isom`/`mp42` one — only that the bytes are a real media container and
 * not, say, a renamed script. Used by the pre-roll ad attach step, which
 * never sees the upload (it went straight to MinIO) and reads the first
 * bytes back with MinioService.readBytes.
 */
export const ISO_BMFF_HEADER_BYTES = 12;

export function isIsoBmff(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.toString('latin1', 4, 8) === 'ftyp';
}
