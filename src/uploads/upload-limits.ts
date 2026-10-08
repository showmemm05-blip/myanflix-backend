/**
 * Hard size budgets for everything staff can upload (M-23). Generous on
 * purpose — they exist to stop one staff login from filling a disk, not to
 * second-guess a real file — and every one of them can be raised through
 * the environment without a code change. Read at call time so a test can
 * set the variable and so a value typed into .env takes effect on restart.
 *
 * Why these numbers:
 *   - video 60 GB: the multipart flow was designed around 10-50 GB
 *     originals (see MULTIPART_PART_SIZE), so the cap sits above the
 *     largest file the flow was ever meant to carry.
 *   - document 500 MB: a 2,000-page scanned PDF (the page cap in
 *     pdf.util.ts) at a few hundred KB per page is well under this.
 *   - free disk 2 GB: the chunked flow merges chunks on the API host, which
 *     also runs Postgres. The disk is checked three times — at init for the
 *     session's whole PEAK (chunks + the merged copy = 2 x filesize, since
 *     the chunks are only deleted after the merge), before every chunk
 *     write and again before the merge — so no write ever takes the disk
 *     below that reserve, whatever other sessions are doing meanwhile.
 *   - open sessions 32 per movie: a bundle uploads four files at a time
 *     and an abandoned session stops counting after 48 h, so a real upload
 *     never gets near it; a login opening sessions by the hundred does.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 60 * GB;
export const DEFAULT_MAX_DOCUMENT_UPLOAD_BYTES = 500 * MB;
export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * GB;
export const DEFAULT_MAX_OPEN_SESSIONS_PER_MOVIE = 32;

/** A positive integer from the environment, or `fallback` when unset or not a positive integer. */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Largest video original / bundle file (bytes) any upload route accepts. */
export function maxVideoUploadBytes(): number {
  return positiveIntFromEnv(
    'UPLOAD_MAX_VIDEO_BYTES',
    DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
  );
}

/** Largest book PDF (bytes) the book upload type and the conversion accept. */
export function maxDocumentUploadBytes(): number {
  return positiveIntFromEnv(
    'UPLOAD_MAX_DOCUMENT_BYTES',
    DEFAULT_MAX_DOCUMENT_UPLOAD_BYTES,
  );
}

/** Free space the chunked flow's scratch disk must keep at every step — after a chunk lands, after the merge, and at the session's peak. */
export function minFreeDiskBytes(): number {
  return positiveIntFromEnv(
    'UPLOAD_MIN_FREE_DISK_BYTES',
    DEFAULT_MIN_FREE_DISK_BYTES,
  );
}

/** Most chunked sessions one movie may have open (IN_PROGRESS, younger than the abandoned-session window) at once. */
export function maxOpenSessionsPerMovie(): number {
  return positiveIntFromEnv(
    'UPLOAD_MAX_OPEN_SESSIONS_PER_MOVIE',
    DEFAULT_MAX_OPEN_SESSIONS_PER_MOVIE,
  );
}

/** Human-readable size for a refusal message: "60 GB", "500 MB". */
export function describeBytes(bytes: number): string {
  if (bytes >= GB && bytes % GB === 0) return `${bytes / GB} GB`;
  if (bytes >= MB && bytes % MB === 0) return `${bytes / MB} MB`;
  return `${bytes} bytes`;
}
