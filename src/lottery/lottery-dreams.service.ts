import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type LotteryDream,
  type LotteryDreamBook,
  type Prisma,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { lotteryDreamSnapshot } from '../audit/audit-snapshots';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import {
  burmeseSearchKey,
  typedDigits,
} from '../common/utils/burmese-search.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  bookFromWire,
  bookToWire,
  dreamNumberWidth,
  isDreamBookWire,
  normalizeDreamNumber,
  type DreamBookWire,
} from './dream-book';
import {
  buildDreamWorkbook,
  DREAM_IMPORT_COLUMNS,
  parseDreamSheet,
} from './dream-sheet';
import {
  DREAM_PAGE_SIZE_DEFAULT,
  LOTTERY_DREAM_LIMITS,
  type AdminDreamQueryDto,
  type DreamAdminFilter,
  type DreamQueryDto,
  type UpdateLotteryDreamDto,
} from './dto/lottery-dream.dto';

/** Error codes a client can branch on; the message is for people. */
export const LOTTERY_DREAM_ERRORS = {
  NOT_FOUND: 'LOTTERY_DREAM_NOT_FOUND',
} as const;

/** How long an applied import may take to write its rows (up to 1,100 updates). */
export const DREAM_IMPORT_TRANSACTION_TIMEOUT_MS = 30_000;

/** One dream as the apps draw it. */
export interface DreamView {
  id: string;
  book: DreamBookWire;
  number: string;
  nameEn: string | null;
  nameMy: string | null;
  pictureUrl: string | null;
}

/** The admin's shape: the same plus the on/off switch. */
export interface StaffDreamView extends DreamView {
  isActive: boolean;
}

export interface StaffDreamPage {
  items: StaffDreamView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DreamImportError {
  /** The row's number in the file, header included — row 2 is the first data row. */
  row: number;
  message: string;
}

export interface DreamImportResult {
  /** Data rows read (blank lines are not rows). */
  total: number;
  updated: number;
  unchanged: number;
  errors: DreamImportError[];
}

/** What one import row would write; only fields that actually differ. */
interface DreamImportChange {
  id: string;
  data: Pick<Prisma.LotteryDreamUpdateInput, 'nameEn' | 'nameMy'>;
}

/** A row customers may see: switched on and named in at least one language. */
const SHOWN_TO_CUSTOMERS: Prisma.LotteryDreamWhereInput = {
  isActive: true,
  OR: [{ nameEn: { not: null } }, { nameMy: { not: null } }],
};

const isShownToCustomers = (
  dream: Pick<LotteryDream, 'isActive' | 'nameEn' | 'nameMy'>,
) => dream.isActive && (dream.nameEn !== null || dream.nameMy !== null);

/** The fields the search box reads. */
export type DreamSearchRow = Pick<
  LotteryDream,
  'book' | 'number' | 'nameEn' | 'nameMy'
>;

/**
 * The search box: a name fragment in either language, or a number.
 *
 * Names are compared by burmeseSearchKey, so a customer's spelling finds the
 * admin's even when it differs by a space, a look-alike letter (၀ for ဝ) or
 * the order of a syllable's marks — and so this runs in memory, over the
 * book's rows (at most 1,100), never as a database `contains`.
 *
 * Digits — ASCII or Burmese — match the start of a number, plus the number
 * those digits zero-pad to, so "27" and "၂၇" find 027 as well as 270-279. A
 * query that reads as a number searches numbers only, as the phone does:
 * "၇" is the digit, not every name with a ရ in it.
 */
export function dreamMatcher(
  q: string,
  book?: LotteryDreamBook,
): (row: DreamSearchRow) => boolean {
  const key = burmeseSearchKey(q);
  const digits = typedDigits(q);
  const padded = new Map<LotteryDreamBook, string>();
  if (digits) {
    const books = book ? [book] : (['DREAM_1000', 'DREAM_100'] as const);
    for (const candidate of books) {
      const number = normalizeDreamNumber(candidate, digits);
      if (number) padded.set(candidate, number);
    }
  }
  return (row) =>
    digits !== null
      ? row.number.startsWith(digits) || padded.get(row.book) === row.number
      : key !== '' &&
        ((row.nameEn !== null && burmeseSearchKey(row.nameEn).includes(key)) ||
          (row.nameMy !== null && burmeseSearchKey(row.nameMy).includes(key)));
}

/** The admin list's to-do filters. */
export function dreamFilterWhere(
  filter: DreamAdminFilter | undefined,
): Prisma.LotteryDreamWhereInput {
  switch (filter) {
    case 'missing_name':
      // Either name still empty — the admin's to-do, stricter than the
      // customer rule (one name is enough to be shown).
      return { OR: [{ nameEn: null }, { nameMy: null }] };
    case 'missing_picture':
      return { pictureUrl: null };
    case 'inactive':
      return { isActive: false };
    default:
      return {};
  }
}

/**
 * The dream books (lottery backend phase 1). Rows are never created or
 * deleted here — the migration seeds exactly one per number — so the
 * service only reads, edits, imports and exports. Every edit and every
 * applied import records one audit row (AuditService contract).
 */
@Injectable()
export class LotteryDreamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------

  async listPublic(query: DreamQueryDto): Promise<{ items: DreamView[] }> {
    const book = bookFromWire(query.book);
    const rows = await this.prisma.lotteryDream.findMany({
      where: { book, AND: [SHOWN_TO_CUSTOMERS] },
      orderBy: { number: 'asc' },
    });
    const hits = query.q ? rows.filter(dreamMatcher(query.q, book)) : rows;
    return { items: hits.map((row) => this.view(row)) };
  }

  /** 404 for an unknown book, a number outside the book, an unnamed or a switched-off dream alike. */
  async findPublic(bookWire: string, rawNumber: string): Promise<DreamView> {
    const book = isDreamBookWire(bookWire) ? bookFromWire(bookWire) : null;
    const number = book ? normalizeDreamNumber(book, rawNumber) : null;
    const row =
      book && number
        ? await this.prisma.lotteryDream.findUnique({
            where: { book_number: { book, number } },
          })
        : null;
    if (!row || !isShownToCustomers(row)) throw this.notFound();
    return this.view(row);
  }

  // ---------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------

  async listAdmin(query: AdminDreamQueryDto): Promise<StaffDreamPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DREAM_PAGE_SIZE_DEFAULT;
    const book = query.book ? bookFromWire(query.book) : undefined;
    const where: Prisma.LotteryDreamWhereInput = {
      ...(book ? { book } : {}),
      AND: [dreamFilterWhere(query.filter)],
    };
    const orderBy: Prisma.LotteryDreamOrderByWithRelationInput[] = [
      { book: 'asc' },
      { number: 'asc' },
    ];
    if (query.q) {
      // The search compares spellings (dreamMatcher), which the database
      // cannot, so the filtered rows — both books together are 1,100 — are
      // read and paged here.
      const rows = await this.prisma.lotteryDream.findMany({ where, orderBy });
      const hits = rows.filter(dreamMatcher(query.q, book));
      return {
        items: hits
          .slice((page - 1) * pageSize, page * pageSize)
          .map((row) => this.staffView(row)),
        total: hits.length,
        page,
        pageSize,
      };
    }
    const [rows, total] = await Promise.all([
      this.prisma.lotteryDream.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lotteryDream.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.staffView(row)),
      total,
      page,
      pageSize,
    };
  }

  async update(
    id: string,
    dto: UpdateLotteryDreamDto,
    actor: AuthenticatedUser,
  ): Promise<StaffDreamView> {
    const before = await this.findRow(id);

    // Absent = keep the stored value; null = clear it. The picture is
    // persisted canonical, like every image URL (MinioService.canonicalImageUrl).
    const data: Prisma.LotteryDreamUpdateInput = {};
    if (dto.nameEn !== undefined) data.nameEn = dto.nameEn;
    if (dto.nameMy !== undefined) data.nameMy = dto.nameMy;
    if (dto.pictureUrl !== undefined) {
      data.pictureUrl = this.minioService.canonicalImageUrl(dto.pictureUrl);
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    const after = await this.prisma.lotteryDream.update({
      where: { id },
      data,
    });

    await this.audit.record({
      action: 'lottery_dream.update',
      actor,
      target: { type: 'lottery_dream', id, label: this.label(after) },
      before: lotteryDreamSnapshot(before),
      after: lotteryDreamSnapshot(after),
      metadata: { book: bookToWire(after.book), number: after.number },
    });
    return this.staffView(after);
  }

  /**
   * Reads a spreadsheet of names and applies it. Every row is judged on its
   * own: a bad book, a number outside the book, a repeat or an over-long
   * name is reported by row number and skipped, the good rows still go
   * through. A blank name cell leaves that name as it is, so a sheet that
   * only carries Burmese never wipes the English. Re-importing the same
   * file changes nothing (every row counts as unchanged). With `dryRun`
   * the counts come back and nothing is written — no rows, no audit.
   */
  async import(
    buffer: Buffer,
    fileName: string,
    dryRun: boolean,
    actor: AuthenticatedUser,
  ): Promise<DreamImportResult> {
    const sheet = await parseDreamSheet(buffer);
    const existing = await this.prisma.lotteryDream.findMany({
      select: {
        id: true,
        book: true,
        number: true,
        nameEn: true,
        nameMy: true,
      },
    });
    const byKey = new Map(
      existing.map((row) => [`${row.book}:${row.number}`, row]),
    );

    const errors: DreamImportError[] = [];
    const changes: DreamImportChange[] = [];
    const seen = new Set<string>();
    let unchanged = 0;

    for (const { row, cells } of sheet.rows) {
      const bookCell = cells[DREAM_IMPORT_COLUMNS.book] ?? '';
      if (!isDreamBookWire(bookCell)) {
        errors.push({
          row,
          message: `Unknown book "${bookCell}". Use 1000 or 100.`,
        });
        continue;
      }
      const book = bookFromWire(bookCell);
      const numberCell = cells[DREAM_IMPORT_COLUMNS.number] ?? '';
      const number = normalizeDreamNumber(book, numberCell);
      if (!number) {
        errors.push({
          row,
          message: `"${numberCell}" is not a number of the ${bookCell} book (${dreamNumberWidth(book)} digits).`,
        });
        continue;
      }
      const key = `${book}:${number}`;
      if (seen.has(key)) {
        errors.push({
          row,
          message: `${bookCell} ${number} appears more than once in the file.`,
        });
        continue;
      }
      seen.add(key);
      const current = byKey.get(key);
      if (!current) {
        errors.push({ row, message: `${bookCell} ${number} does not exist.` });
        continue;
      }

      const nameEn = cells[DREAM_IMPORT_COLUMNS.nameEn] ?? null;
      const nameMy = cells[DREAM_IMPORT_COLUMNS.nameMy] ?? null;
      const tooLong = [nameEn, nameMy].find(
        (name) => name !== null && name.length > LOTTERY_DREAM_LIMITS.name,
      );
      if (tooLong !== undefined) {
        errors.push({
          row,
          message: `A name is longer than ${LOTTERY_DREAM_LIMITS.name} characters.`,
        });
        continue;
      }

      const data: DreamImportChange['data'] = {};
      if (nameEn !== null && nameEn !== current.nameEn) data.nameEn = nameEn;
      if (nameMy !== null && nameMy !== current.nameMy) data.nameMy = nameMy;
      if (Object.keys(data).length === 0) {
        unchanged += 1;
        continue;
      }
      changes.push({ id: current.id, data });
    }

    const result: DreamImportResult = {
      total: sheet.rows.length,
      updated: changes.length,
      unchanged,
      errors,
    };
    if (dryRun) return result;

    // The rows and their one audit line commit together.
    await this.prisma.$transaction(
      async (tx) => {
        for (const change of changes) {
          await tx.lotteryDream.update({
            where: { id: change.id },
            data: change.data,
          });
        }
        await this.audit.record({
          action: 'lottery_dream.import',
          actor,
          target: { type: 'lottery_dream', id: null, label: fileName },
          metadata: {
            fileName,
            total: result.total,
            updated: result.updated,
            unchanged: result.unchanged,
            errors: errors.length,
          },
          tx,
        });
      },
      { timeout: DREAM_IMPORT_TRANSACTION_TIMEOUT_MS },
    );
    return result;
  }

  /** Every row of one book as an .xlsx — the import template, pre-filled. */
  async export(bookWire: DreamBookWire): Promise<Buffer> {
    const rows = await this.prisma.lotteryDream.findMany({
      where: { book: bookFromWire(bookWire) },
      orderBy: { number: 'asc' },
    });
    return buildDreamWorkbook(
      rows.map((row) => ({
        book: bookWire,
        number: row.number,
        nameEn: row.nameEn,
        nameMy: row.nameMy,
        hasPicture: row.pictureUrl !== null,
        isActive: row.isActive,
      })),
    );
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private async findRow(id: string): Promise<LotteryDream> {
    const row = await this.prisma.lotteryDream.findUnique({ where: { id } });
    if (!row) throw this.notFound();
    return row;
  }

  private notFound() {
    return new CodedHttpException(
      HttpStatus.NOT_FOUND,
      LOTTERY_DREAM_ERRORS.NOT_FOUND,
      'Dream not found',
    );
  }

  /** "1000/027" — what the audit log shows for a dream. */
  private label(dream: Pick<LotteryDream, 'book' | 'number'>): string {
    return `${bookToWire(dream.book)}/${dream.number}`;
  }

  private view(row: LotteryDream): DreamView {
    return {
      id: row.id,
      book: bookToWire(row.book),
      number: row.number,
      nameEn: row.nameEn,
      nameMy: row.nameMy,
      pictureUrl: this.minioService.imageUrl(row.pictureUrl),
    };
  }

  private staffView(row: LotteryDream): StaffDreamView {
    return { ...this.view(row), isActive: row.isActive };
  }
}
