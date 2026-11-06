import { Workbook } from 'exceljs';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import {
  buildDreamWorkbook,
  DREAM_IMPORT_MAX_ROWS,
  DREAM_SHEET_ERRORS,
  isXlsxBuffer,
  normalizeColumnName,
  parseCsv,
  parseDreamSheet,
} from './dream-sheet';

/** Catches the coded error a promise rejects with. */
async function codedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

/** A workbook whose first sheet holds exactly these cells, as a Buffer. */
async function xlsxOf(grid: unknown[][]): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of grid) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('parseCsv', () => {
  it('splits rows on LF and CRLF and drops a byte-order mark', () => {
    expect(parseCsv('﻿a,b\r\nc,d\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('keeps commas, doubled quotes and line breaks inside a quoted field', () => {
    expect(parseCsv('"x, y","say ""hi""","two\nlines",plain\n')).toEqual([
      ['x, y', 'say "hi"', 'two\nlines', 'plain'],
    ]);
  });

  it('keeps empty fields and blank lines in place (the caller skips them)', () => {
    expect(parseCsv('a,,c\n\n,,\n')).toEqual([
      ['a', '', 'c'],
      [''],
      ['', '', ''],
    ]);
  });

  it('reads an empty string as no rows', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('stops at the row cap instead of reading the whole text first', () => {
    const atCap = 'h\n' + 'x\n'.repeat(DREAM_IMPORT_MAX_ROWS);
    expect(parseCsv(atCap)).toHaveLength(DREAM_IMPORT_MAX_ROWS + 1);
    expect(() => parseCsv(atCap + 'one more\n')).toThrow(CodedHttpException);
  });
});

describe('normalizeColumnName', () => {
  it('lower-cases and joins words with underscores', () => {
    expect(normalizeColumnName(' Name EN ')).toBe('name_en');
    expect(normalizeColumnName('name-my')).toBe('name_my');
    expect(normalizeColumnName('number')).toBe('number');
  });
});

describe('isXlsxBuffer', () => {
  it('is true for a zip signature and false for text', () => {
    expect(isXlsxBuffer(Buffer.from('PK\u0003\u0004rest'))).toBe(true);
    expect(isXlsxBuffer(Buffer.from('book,number\n'))).toBe(false);
    expect(isXlsxBuffer(Buffer.alloc(0))).toBe(false);
  });
});

describe('parseDreamSheet', () => {
  it('keys CSV rows by their header, trims cells, skips blank cells and blank lines', async () => {
    const csv = [
      '﻿Book,Number,Name EN,name_my,extra',
      '1000, 27 , Snake ,,ignored',
      '',
      '100,7,,မြွေ',
      ',,,',
    ].join('\r\n');

    const sheet = await parseDreamSheet(Buffer.from(csv, 'utf8'));

    expect(sheet.columns).toEqual([
      'book',
      'number',
      'name_en',
      'name_my',
      'extra',
    ]);
    expect(sheet.rows).toEqual([
      {
        row: 2,
        cells: {
          book: '1000',
          number: '27',
          name_en: 'Snake',
          extra: 'ignored',
        },
      },
      { row: 4, cells: { book: '100', number: '7', name_my: 'မြွေ' } },
    ]);
  });

  it('reads a workbook, showing a numeric cell as its text', async () => {
    const sheet = await parseDreamSheet(
      await xlsxOf([
        ['book', 'number', 'name_en', 'name_my'],
        [1000, 27, 'Snake', null],
        [],
        ['100', '07', '', 'မြွေ'],
      ]),
    );

    expect(sheet.rows).toEqual([
      { row: 2, cells: { book: '1000', number: '27', name_en: 'Snake' } },
      { row: 4, cells: { book: '100', number: '07', name_my: 'မြွေ' } },
    ]);
  });

  it('accepts a sheet with only one name column', async () => {
    const sheet = await parseDreamSheet(
      Buffer.from('book,number,name_my\n1000,27,မြွေ\n'),
    );
    expect(sheet.rows).toHaveLength(1);
  });

  it('400s when book or number is missing from the header', async () => {
    const error = await codedError(
      parseDreamSheet(Buffer.from('number,name_en\n27,Snake\n')),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe(DREAM_SHEET_ERRORS.COLUMNS_MISSING);
  });

  it('400s when neither name column is there', async () => {
    const error = await codedError(
      parseDreamSheet(Buffer.from('book,number,is_active\n1000,27,yes\n')),
    );
    expect(error.code).toBe(DREAM_SHEET_ERRORS.COLUMNS_MISSING);
  });

  it('400s a file with more rows than a dream book', async () => {
    const lines = ['book,number,name_en'];
    for (let i = 0; i <= DREAM_IMPORT_MAX_ROWS; i += 1) {
      lines.push(`1000,${i % 1000},x`);
    }
    const error = await codedError(
      parseDreamSheet(Buffer.from(lines.join('\n'))),
    );
    expect(error.code).toBe(DREAM_SHEET_ERRORS.TOO_MANY_ROWS);
  });

  it('400s a workbook with more rows than a dream book, by its row count', async () => {
    const grid: unknown[][] = [['book', 'number', 'name_en']];
    for (let i = 0; i <= DREAM_IMPORT_MAX_ROWS; i += 1) {
      grid.push(['1000', i % 1000, 'x']);
    }
    const error = await codedError(parseDreamSheet(await xlsxOf(grid)));
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe(DREAM_SHEET_ERRORS.TOO_MANY_ROWS);
  });

  it('400s bytes that claim to be a workbook but are not one', async () => {
    const error = await codedError(
      parseDreamSheet(Buffer.from('PK\u0003\u0004 this is not a zip')),
    );
    expect(error.code).toBe(DREAM_SHEET_ERRORS.UNREADABLE);
  });

  it('400s a picture and a UTF-16 text as unreadable, not as missing columns', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0xff),
    ]);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('book,number,name_en\n1000,27,Snake\n', 'utf16le'),
    ]);

    for (const bytes of [png, utf16]) {
      const error = await codedError(parseDreamSheet(bytes));
      expect(error.getStatus()).toBe(400);
      expect(error.code).toBe(DREAM_SHEET_ERRORS.UNREADABLE);
    }
  });
});

describe('buildDreamWorkbook', () => {
  it('writes a workbook the import reads back, numbers with their zeros', async () => {
    const file = await buildDreamWorkbook([
      {
        book: '1000',
        number: '027',
        nameEn: 'Snake',
        nameMy: null,
        hasPicture: true,
        isActive: true,
      },
      {
        book: '1000',
        number: '028',
        nameEn: null,
        nameMy: null,
        hasPicture: false,
        isActive: false,
      },
    ]);

    expect(isXlsxBuffer(file)).toBe(true);
    const sheet = await parseDreamSheet(file);
    expect(sheet.columns).toEqual([
      'book',
      'number',
      'name_en',
      'name_my',
      'has_picture',
      'is_active',
    ]);
    expect(sheet.rows).toEqual([
      {
        row: 2,
        cells: {
          book: '1000',
          number: '027',
          name_en: 'Snake',
          has_picture: 'yes',
          is_active: 'yes',
        },
      },
      {
        row: 3,
        cells: {
          book: '1000',
          number: '028',
          has_picture: 'no',
          is_active: 'no',
        },
      },
    ]);
  });
});
