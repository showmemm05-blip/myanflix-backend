import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_PDF_PAGES,
  MAX_RENDER_LONG_EDGE_PX,
  PDFINFO_TIMEOUT_MS,
  PDFTOPPM_PAGE_TIMEOUT_MS,
  PDF_RENDER_DPI,
  probePdf,
  renderDpiForPage,
  renderPdfPageToPng,
} from './pdf.util';

// pdf.util promisifies execFile at module load, and promisify honours the
// `util.promisify.custom` hook — so the mock carries one, and the tests
// drive THAT (what the promise form receives: file, args, options).
jest.mock('node:child_process', () => {
  const { promisify: p } =
    jest.requireActual<typeof import('node:util')>('node:util');
  const execFileAsync = jest.fn();
  const execFileMock = Object.assign(jest.fn(), {
    [p.custom]: execFileAsync,
  });
  return { execFile: execFileMock };
});

const execFileAsync = (execFile as unknown as Record<symbol, jest.Mock>)[
  promisify.custom
];

/** What `execFile` rejects with when its timeout fires: killed with the configured signal. */
const timeoutError = () =>
  Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });

const PDFINFO_OUTPUT = (pages: number, extra = '') =>
  [
    'Creator:        scanner',
    `Pages:          ${pages}`,
    'Encrypted:      no',
    'Page    1 size:  612 x 792 pts (letter)',
    'Page    1 rot:   0',
    'Page    2 size:  5760 x 2880 pts',
    'Page    2 rot:   90',
    extra,
    'File size:      428 bytes',
  ].join('\n');

describe('pdf.util (M-9 / M-24)', () => {
  beforeEach(() => {
    execFileAsync.mockReset();
  });

  describe('probePdf', () => {
    it('runs pdfinfo with a hard timeout and SIGKILL, asking for the page range up to the cap', async () => {
      execFileAsync.mockResolvedValue({
        stdout: PDFINFO_OUTPUT(2),
        stderr: '',
      });

      await probePdf('/scratch/original.pdf');

      expect(execFileAsync).toHaveBeenCalledWith(
        'pdfinfo',
        ['-f', '1', '-l', String(MAX_PDF_PAGES), '/scratch/original.pdf'],
        expect.objectContaining({
          timeout: PDFINFO_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        }),
      );
    });

    it('returns the page count and every listed page size in points', async () => {
      execFileAsync.mockResolvedValue({
        stdout: PDFINFO_OUTPUT(2),
        stderr: '',
      });

      const probe = await probePdf('/scratch/original.pdf');

      expect(probe.pageCount).toBe(2);
      expect(probe.pageSizes.get(1)).toEqual({ widthPt: 612, heightPt: 792 });
      expect(probe.pageSizes.get(2)).toEqual({ widthPt: 5760, heightPt: 2880 });
      expect(probe.pageSizes.has(3)).toBe(false);
    });

    it(`refuses a document over ${MAX_PDF_PAGES} pages before anything is rendered`, async () => {
      execFileAsync.mockResolvedValue({
        stdout: PDFINFO_OUTPUT(MAX_PDF_PAGES + 1),
        stderr: '',
      });

      await expect(probePdf('/scratch/original.pdf')).rejects.toThrow(
        `The PDF has ${MAX_PDF_PAGES + 1} pages — a chapter may have at most ${MAX_PDF_PAGES}`,
      );
    });

    it(`accepts exactly ${MAX_PDF_PAGES} pages`, async () => {
      execFileAsync.mockResolvedValue({
        stdout: PDFINFO_OUTPUT(MAX_PDF_PAGES),
        stderr: '',
      });

      await expect(probePdf('/scratch/original.pdf')).resolves.toMatchObject({
        pageCount: MAX_PDF_PAGES,
      });
    });

    it('turns a pdfinfo that had to be killed into a readable failure, not a hang', async () => {
      execFileAsync.mockRejectedValue(timeoutError());

      await expect(probePdf('/scratch/original.pdf')).rejects.toThrow(
        /pdfinfo did not finish within 60 s/,
      );
    });

    it('still refuses an empty or corrupt document', async () => {
      execFileAsync.mockResolvedValue({ stdout: 'Pages:  0\n', stderr: '' });

      await expect(probePdf('/scratch/original.pdf')).rejects.toThrow(
        /no pages/,
      );
    });
  });

  describe('renderDpiForPage', () => {
    it('keeps the standard DPI for an ordinary page — a letter page renders exactly as before', () => {
      expect(renderDpiForPage({ widthPt: 612, heightPt: 792 })).toBe(
        PDF_RENDER_DPI,
      );
      // A3 landscape, 16.5 inches on the long side.
      expect(renderDpiForPage({ widthPt: 1191, heightPt: 842 })).toBe(
        PDF_RENDER_DPI,
      );
    });

    it('keeps the standard DPI when the page size is unknown', () => {
      expect(renderDpiForPage(undefined)).toBe(PDF_RENDER_DPI);
      expect(renderDpiForPage({ widthPt: 0, heightPt: 0 })).toBe(
        PDF_RENDER_DPI,
      );
    });

    it(`lowers the DPI so a poster-sized page never exceeds ${MAX_RENDER_LONG_EDGE_PX} px on its long edge`, () => {
      // 80 x 80 inches — what used to cost ~590 MB in one pdftoppm process.
      const dpi = renderDpiForPage({ widthPt: 5760, heightPt: 5760 });
      expect(dpi).toBe(50);
      expect((5760 / 72) * dpi).toBeLessThanOrEqual(MAX_RENDER_LONG_EDGE_PX);
    });

    it('never goes below 1 DPI, even for an absurd MediaBox', () => {
      expect(renderDpiForPage({ widthPt: 1e9, heightPt: 10 })).toBe(1);
    });
  });

  describe('renderPdfPageToPng', () => {
    it('runs pdftoppm with a per-page timeout, SIGKILL and the DPI it was given', async () => {
      execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      const png = await renderPdfPageToPng(
        '/scratch/original.pdf',
        7,
        '/scratch/page-7',
        50,
      );

      expect(png).toBe('/scratch/page-7.png');
      expect(execFileAsync).toHaveBeenCalledWith(
        'pdftoppm',
        [
          '-f',
          '7',
          '-l',
          '7',
          '-singlefile',
          '-r',
          '50',
          '-png',
          '/scratch/original.pdf',
          '/scratch/page-7',
        ],
        { timeout: PDFTOPPM_PAGE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      );
    });

    it('defaults to the standard DPI when none is given', async () => {
      execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      await renderPdfPageToPng('/scratch/original.pdf', 1, '/scratch/page-1');

      const [, args] = execFileAsync.mock.calls[0] as [string, string[]];
      expect(args).toContain(String(PDF_RENDER_DPI));
    });

    it('reports a page that had to be killed as a failure of that page', async () => {
      execFileAsync.mockRejectedValue(timeoutError());

      await expect(
        renderPdfPageToPng('/scratch/original.pdf', 9, '/scratch/page-9'),
      ).rejects.toThrow(/did not finish page 9 within 120 s/);
    });
  });
});
