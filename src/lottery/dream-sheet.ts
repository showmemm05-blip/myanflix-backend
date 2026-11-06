import { HttpStatus } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { CodedHttpException } from '../common/errors/coded-http.exception';

/**
 * The spreadsheet side of the dream books: reading an uploaded .xlsx or
 * .csv into header-keyed rows (the import), and writing one book out as an
 * .xlsx (the export, which doubles as the import template).
 *
 * Column names are matched after lower-casing and turning spaces and
 * dashes into underscores, so "Name EN" and "name_en" are the same column.
 */

/** The columns the import reads; the rest of a row is ignored. */
export const DREAM_IMPORT_COLUMNS = {
  book: 'book',
  number: 'number',
  nameEn: 'name_en',
  nameMy: 'name_my',
} as const;

/** More than this is not a dream book (both books together are 1,100 rows). */
export const DREAM_IMPORT_MAX_ROWS = 5000;

export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const DREAM_SHEET_ERRORS = {
  UNREADABLE: 'LOTTERY_DREAM_SHEET_UNREADABLE',
  COLUMNS_MISSING: 'LOTTERY_DREAM_SHEET_COLUMNS_MISSING',
  TOO_MANY_ROWS: 'LOTTERY_DREAM_SHEET_TOO_MANY_ROWS',
} as const;

const badRequest = (code: string, message: string) =>
  new CodedHttpException(HttpStatus.BAD_REQUEST, code, message);

const tooManyRows = () =>
  badRequest(
    DREAM_SHEET_ERRORS.TOO_MANY_ROWS,
    `The file has more than ${DREAM_IMPORT_MAX_ROWS} rows.`,
  );

const unreadable = () =>
  badRequest(
    DREAM_SHEET_ERRORS.UNREADABLE,
    'Could not read the file. Upload an .xlsx workbook or a UTF-8 .csv file.',
  );

/**
 * A control character or a replacement character (U+FFFD, what a byte that
 * is not UTF-8 decodes to) in the header line: the bytes are a picture, a
 * UTF-16 text, an old .xls — not a CSV. Tabs are allowed, a tab-separated
 * header still reads as one (wrong) column name and gets the columns error.
 */
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

export interface SheetRow {
  /** The row's number in the file, header included — row 2 is the first data row. */
  row: number;
  /** Cell text by normalised column name; a missing cell is absent. */
  cells: Record<string, string>;
}

export interface DreamSheet {
  columns: string[];
  rows: SheetRow[];
}

/** A zip (and so an .xlsx) starts with "PK\x03\x04"; anything else is read as text. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function isXlsxBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= ZIP_MAGIC.length &&
    buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)
  );
}

/** "Name EN" / " name-en " -> "name_en". */
export function normalizeColumnName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * RFC 4180 CSV: fields split on commas, a field may be wrapped in double
 * quotes to carry commas, quotes (doubled) or line breaks; rows end in LF
 * or CRLF. A UTF-8 byte-order mark is dropped. Returns every row as its
 * raw cells, blank lines included (the caller skips them). Throws the
 * too-many-rows 400 as soon as the header plus DREAM_IMPORT_MAX_ROWS rows
 * are behind it, so a huge file is not held in memory first.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      if (rows.length > DREAM_IMPORT_MAX_ROWS + 1) throw tooManyRows();
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  // The last line need not end in a line break.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Header-keys a grid of cells; rows with no text at all are dropped. */
function keyRows(grid: string[][]): DreamSheet {
  const [header, ...body] = grid;
  const columns = (header ?? []).map(normalizeColumnName);
  const rows: SheetRow[] = [];
  body.forEach((cells, index) => {
    const row: SheetRow = { row: index + 2, cells: {} };
    let hasText = false;
    columns.forEach((column, position) => {
      if (!column) return;
      const text = (cells[position] ?? '').trim();
      if (text === '') return;
      row.cells[column] = text;
      hasText = true;
    });
    if (hasText) rows.push(row);
  });
  return { columns: columns.filter(Boolean), rows };
}

/**
 * exceljs types its byte arguments as its own ArrayBuffer stand-in; a Node
 * Buffer is what it takes at runtime.
 */
type ExcelBytes = Parameters<Workbook['xlsx']['load']>[0];

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelBytes);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  // Refused before the grid is built: an .xlsx packs 10-50x, so a file under
  // the upload cap can still hold hundreds of thousands of rows.
  if (sheet.rowCount > DREAM_IMPORT_MAX_ROWS + 1) throw tooManyRows();
  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      // `text` is what the spreadsheet shows: a number cell 27 reads "27",
      // a formula its result, rich text its plain words.
      cells[column - 1] = cell.text ?? '';
    });
    grid[rowNumber - 1] = cells;
  });
  // eachRow leaves holes for rows the file never wrote.
  return Array.from(grid, (cells) => cells ?? []);
}

/**
 * Reads an uploaded dream sheet. Throws a 400 when the bytes are neither a
 * workbook nor text, when the header lacks `book` / `number` or both name
 * columns, or when the file is far bigger than a dream book.
 */
export async function parseDreamSheet(buffer: Buffer): Promise<DreamSheet> {
  let grid: string[][];
  if (isXlsxBuffer(buffer)) {
    try {
      grid = await readXlsx(buffer);
    } catch (error) {
      // The row cap is our own 400 and keeps its code; anything exceljs
      // throws means the bytes are not a workbook.
      if (error instanceof CodedHttpException) throw error;
      throw unreadable();
    }
  } else {
    const text = buffer.toString('utf8');
    const headerLine = text.split(/\r?\n/, 1)[0] ?? '';
    if (NOT_TEXT.test(headerLine)) throw unreadable();
    grid = parseCsv(text);
  }

  const sheet = keyRows(grid);
  const has = (column: string) => sheet.columns.includes(column);
  if (!has(DREAM_IMPORT_COLUMNS.book) || !has(DREAM_IMPORT_COLUMNS.number)) {
    throw badRequest(
      DREAM_SHEET_ERRORS.COLUMNS_MISSING,
      'The first row must name the columns book and number.',
    );
  }
  if (!has(DREAM_IMPORT_COLUMNS.nameEn) && !has(DREAM_IMPORT_COLUMNS.nameMy)) {
    throw badRequest(
      DREAM_SHEET_ERRORS.COLUMNS_MISSING,
      'The first row must name a name_en or name_my column.',
    );
  }
  // Blank lines are not rows, so a text file can still pass the parser's
  // own cap and land here; the workbook path is capped in readXlsx.
  if (sheet.rows.length > DREAM_IMPORT_MAX_ROWS) throw tooManyRows();
  return sheet;
}

export interface DreamSheetRow {
  book: string;
  number: string;
  nameEn: string | null;
  nameMy: string | null;
  hasPicture: boolean;
  isActive: boolean;
}

/**
 * One book as an .xlsx: the header row, then one row per number. Numbers
 * are written as text so "027" keeps its zeros when the file is opened
 * and saved again — which is exactly how the export comes back as an
 * import.
 */
export async function buildDreamWorkbook(
  rows: readonly DreamSheetRow[],
): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Dreams');
  sheet.columns = [
    { header: 'book', key: 'book', width: 8 },
    { header: 'number', key: 'number', width: 10 },
    { header: 'name_en', key: 'name_en', width: 32 },
    { header: 'name_my', key: 'name_my', width: 32 },
    { header: 'has_picture', key: 'has_picture', width: 12 },
    { header: 'is_active', key: 'is_active', width: 10 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('number').numFmt = '@';
  for (const row of rows) {
    sheet.addRow({
      book: row.book,
      number: row.number,
      name_en: row.nameEn ?? '',
      name_my: row.nameMy ?? '',
      has_picture: row.hasPicture ? 'yes' : 'no',
      is_active: row.isActive ? 'yes' : 'no',
    });
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes);
}
