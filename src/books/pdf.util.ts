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
 * Most pages a chapter PDF may have (M-9 / M-24). A real chapter is tens of
 * pages; a whole scanned book is hundreds. Anything past this is either a
 * mistake or an attempt to pin the server for hours, and it is refused
 * before a single page renders.
 */
export const MAX_PDF_PAGES = 2000;

/**
 * Longest edge, in pixels, any page is ever rasterised at (M-24). At 150 DPI
 * a letter page is 1,650 px tall, so an ordinary page renders exactly as it
 * always did; only a page over ~26 inches on its long side gets a lower DPI
 * so the raw bitmap stays at or under 4000 px — ~64 MB of pixels at most,
 * instead of the multi-gigabyte image a poster-sized MediaBox used to force
 * before sharp ever got to shrink it.
 */
export const MAX_RENDER_LONG_EDGE_PX = 4000;

/** How long pdfinfo may take to read the document info — it only parses the page tree. */
export const PDFINFO_TIMEOUT_MS = 60_000;

/** How long ONE page may take to rasterise before pdftoppm is killed (M-24). */
export const PDFTOPPM_PAGE_TIMEOUT_MS = 120_000;

/** pdfinfo prints two lines per page when asked for a range; 2,000 pages is well under this. */
const PDFINFO_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Width and height of one page in PDF points (1/72 inch), as pdfinfo reports them. */
export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

export interface PdfProbe {
  pageCount: number;
  /** Per page (1-based), for every page pdfinfo listed. */
  pageSizes: Map<number, PdfPageSize>;
}

/**
 * The books equivalent of ffmpeg.util.ts: thin promise wrappers around the
 * poppler CLI binaries (pdfinfo / pdftoppm) the conversion pipeline shells
 * out to — installed via apt in the Docker image, via Homebrew for local
 * dev. Nothing here touches the DB or MinIO.
 *
 * Every shell-out runs with a hard timeout and SIGKILL (M-24): a PDF that
 * makes poppler loop used to hang the conversion forever, and with it the
 * chapter's in-memory reservation, until the backend was restarted.
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

/** execFile's timeout rejection: the child was killed with the configured signal. */
function wasKilledByTimeout(error: unknown): boolean {
  const e = error as { killed?: boolean; signal?: string | null };
  return e?.killed === true && e?.signal === 'SIGKILL';
}

/**
 * Page count and per-page sizes of the PDF, from one `pdfinfo` run.
 * Asked for pages 1..MAX_PDF_PAGES (pdfinfo clamps the range to the
 * document), so a document over the cap is refused here, before anything
 * is rasterised — the page loop never even starts.
 */
export async function probePdf(pdfPath: string): Promise<PdfProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'pdfinfo',
      ['-f', '1', '-l', String(MAX_PDF_PAGES), pdfPath],
      {
        timeout: PDFINFO_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: PDFINFO_MAX_OUTPUT_BYTES,
      },
    ));
  } catch (error) {
    if (isEnoent(error)) throw new PdfToolMissingError('pdfinfo');
    if (wasKilledByTimeout(error)) {
      throw new Error(
        `pdfinfo did not finish within ${PDFINFO_TIMEOUT_MS / 1000} s — the PDF was not converted`,
      );
    }
    throw new Error(
      `pdfinfo could not read the PDF: ${(error as Error).message}`,
    );
  }

  const match = /^Pages:\s+(\d+)/m.exec(stdout);
  const pageCount = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(
      'pdfinfo reported no pages — the PDF appears to be empty or corrupt',
    );
  }
  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(
      `The PDF has ${pageCount} pages — a chapter may have at most ${MAX_PDF_PAGES}`,
    );
  }

  // "Page    7 size:  612 x 792 pts (letter)" — one line per page in the
  // requested range; the trailing paper name is optional.
  const pageSizes = new Map<number, PdfPageSize>();
  const sizeLine = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm;
  for (
    let found = sizeLine.exec(stdout);
    found !== null;
    found = sizeLine.exec(stdout)
  ) {
    const widthPt = Number(found[2]);
    const heightPt = Number(found[3]);
    if (Number.isFinite(widthPt) && Number.isFinite(heightPt)) {
      pageSizes.set(Number(found[1]), { widthPt, heightPt });
    }
  }
  return { pageCount, pageSizes };
}

/**
 * The DPI one page renders at: the standard PDF_RENDER_DPI, lowered only as
 * far as needed so the page's long edge stays within MAX_RENDER_LONG_EDGE_PX.
 * An unknown size (pdfinfo listed no line for the page) gets the standard
 * DPI, exactly as before.
 */
export function renderDpiForPage(size: PdfPageSize | undefined): number {
  if (!size) return PDF_RENDER_DPI;
  const longEdgePt = Math.max(size.widthPt, size.heightPt);
  if (!(longEdgePt > 0)) return PDF_RENDER_DPI;
  const longEdgeAtDefault = (longEdgePt / 72) * PDF_RENDER_DPI;
  if (longEdgeAtDefault <= MAX_RENDER_LONG_EDGE_PX) return PDF_RENDER_DPI;
  return Math.max(1, Math.floor((MAX_RENDER_LONG_EDGE_PX * 72) / longEdgePt));
}

/**
 * Renders exactly one page to a PNG at `outputPathWithoutExt`.png and
 * returns that path. `-singlefile` makes pdftoppm write the bare prefix
 * with no page-number suffix, so the caller never has to guess poppler's
 * zero-padding rules. `dpi` defaults to PDF_RENDER_DPI; the pipeline passes
 * renderDpiForPage() so an oversized page is rendered bounded.
 */
export async function renderPdfPageToPng(
  pdfPath: string,
  pageNumber: number,
  outputPathWithoutExt: string,
  dpi: number = PDF_RENDER_DPI,
): Promise<string> {
  const page = String(pageNumber);
  try {
    await execFileAsync(
      'pdftoppm',
      [
        '-f',
        page,
        '-l',
        page,
        '-singlefile',
        '-r',
        String(dpi),
        '-png',
        pdfPath,
        outputPathWithoutExt,
      ],
      { timeout: PDFTOPPM_PAGE_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );
  } catch (error) {
    if (isEnoent(error)) throw new PdfToolMissingError('pdftoppm');
    if (wasKilledByTimeout(error)) {
      throw new Error(
        `pdftoppm did not finish page ${pageNumber} within ${PDFTOPPM_PAGE_TIMEOUT_MS / 1000} s and was stopped`,
      );
    }
    throw new Error(
      `pdftoppm failed on page ${pageNumber}: ${(error as Error).message}`,
    );
  }
  return `${outputPathWithoutExt}.png`;
}
