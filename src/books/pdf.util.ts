import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Rasterisation DPI. 150 keeps body text crisp on both desktop and phone
 * screens without ballooning a page into a multi-megabyte image; the sharp
 * step afterwards caps pixel dimensions anyway, so an unusually large page
 * ends up bounded rather than enormous.
 */
export const PDF_RENDER_DPI = 150;

/**
 * The books equivalent of ffmpeg.util.ts: thin promise wrappers around the
 * poppler CLI binaries (pdfinfo / pdftoppm) the conversion pipeline shells
 * out to — installed via apt in the Docker image, via Homebrew for local
 * dev. Nothing here touches the DB or MinIO.
 */

class PdfToolMissingError extends Error {
  constructor(binary: string) {
    super(
      `${binary} not found — the PDF conversion pipeline needs poppler-utils ` +
        `(Docker: apt-get install poppler-utils; macOS dev: brew install poppler)`,
    );
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Page count of the PDF, from `pdfinfo`. */
export async function probePdf(pdfPath: string): Promise<{ pageCount: number }> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('pdfinfo', [pdfPath]));
  } catch (error) {
    if (isEnoent(error)) throw new PdfToolMissingError('pdfinfo');
    throw new Error(
      `pdfinfo could not read the PDF: ${(error as Error).message}`,
    );
  }

  const match = /^Pages:\s+(\d+)/m.exec(stdout);
  const pageCount = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('pdfinfo reported no pages — the PDF appears to be empty or corrupt');
  }
  return { pageCount };
}

/**
 * Renders exactly one page to a PNG at `outputPathWithoutExt`.png and
 * returns that path. `-singlefile` makes pdftoppm write the bare prefix
 * with no page-number suffix, so the caller never has to guess poppler's
 * zero-padding rules.
 */
export async function renderPdfPageToPng(
  pdfPath: string,
  pageNumber: number,
  outputPathWithoutExt: string,
): Promise<string> {
  const page = String(pageNumber);
  try {
    await execFileAsync('pdftoppm', [
      '-f',
      page,
      '-l',
      page,
      '-singlefile',
      '-r',
      String(PDF_RENDER_DPI),
      '-png',
      pdfPath,
      outputPathWithoutExt,
    ]);
  } catch (error) {
    if (isEnoent(error)) throw new PdfToolMissingError('pdftoppm');
    throw new Error(
      `pdftoppm failed on page ${pageNumber}: ${(error as Error).message}`,
    );
  }
  return `${outputPathWithoutExt}.png`;
}
