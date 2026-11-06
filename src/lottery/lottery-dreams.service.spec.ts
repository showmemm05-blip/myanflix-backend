import { Test, TestingModule } from '@nestjs/testing';
import {
  LotteryDreamBook,
  Role,
  type LotteryDream,
} from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { CodedHttpException } from '../common/errors/coded-http.exception';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import { isXlsxBuffer, parseDreamSheet } from './dream-sheet';
import {
  dreamFilterWhere,
  dreamMatcher,
  LOTTERY_DREAM_ERRORS,
  LotteryDreamsService,
} from './lottery-dreams.service';

const actor = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

const DREAM_ID = '22222222-2222-4222-8222-222222222222';

function makeDream(overrides: Partial<LotteryDream> = {}): LotteryDream {
  return {
    id: DREAM_ID,
    book: LotteryDreamBook.DREAM_1000,
    number: '027',
    nameEn: 'Snake',
    nameMy: 'မြွေ',
    pictureUrl: null,
    isActive: true,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides,
  };
}

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

const SHOWN = {
  isActive: true,
  OR: [{ nameEn: { not: null } }, { nameMy: { not: null } }],
};

describe('LotteryDreamsService', () => {
  let service: LotteryDreamsService;
  let prisma: {
    lotteryDream: Record<
      'findMany' | 'findUnique' | 'update' | 'count',
      jest.Mock
    >;
    $transaction: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let minio: { imageUrl: jest.Mock; canonicalImageUrl: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lotteryDream: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      // The interactive transaction hands the same mock back as `tx`.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    minio = {
      // Re-hosting is visible in the output: STORED -> REQUEST.
      imageUrl: jest.fn((url: string | null) =>
        url ? url.replace('STORED', 'REQUEST') : null,
      ),
      canonicalImageUrl: jest.fn((url: string | null) =>
        url ? url.replace('REQUEST', 'STORED') : url,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotteryDreamsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MinioService, useValue: minio },
      ],
    }).compile();

    service = module.get(LotteryDreamsService);
  });

  describe('dreamMatcher', () => {
    const row = (
      number: string,
      nameEn: string | null,
      nameMy: string | null,
      book: LotteryDreamBook = LotteryDreamBook.DREAM_1000,
    ) => ({ book, number, nameEn, nameMy });
    const snake = row('027', 'Snake', 'မြွေ');
    const bigFish = row('270', 'Big Fish', 'ငါး ကြီး');
    const pig = row('127', null, '၀က်');

    it('matches a word in either name, case-insensitively', () => {
      const hits = dreamMatcher('sna');
      expect(hits(snake)).toBe(true);
      expect(hits(bigFish)).toBe(false);
      expect(dreamMatcher('ြွေ')(snake)).toBe(true);
      expect(dreamMatcher('FISH')(bigFish)).toBe(true);
    });

    it('reads the names and the search as spellings, not characters', () => {
      // No space, a zero typed for ဝ, marks in the other order.
      expect(dreamMatcher('ငါးကြီး')(bigFish)).toBe(true);
      expect(dreamMatcher('ဝက်')(pig)).toBe(true);
      expect(dreamMatcher('၀က်')(row('128', null, 'ဝက်'))).toBe(true);
      expect(dreamMatcher('ကုိ')(row('129', null, 'ကို'))).toBe(true);
      expect(dreamMatcher('ကူ')(row('129', null, 'ကို'))).toBe(false);
    });

    it('matches digits as a number prefix and as the padded number of the book', () => {
      const hits = dreamMatcher('27', LotteryDreamBook.DREAM_1000);
      expect(hits(snake)).toBe(true); // 027, padded
      expect(hits(bigFish)).toBe(true); // 270, prefix
      expect(hits(pig)).toBe(false); // 127
      // Burmese digits, and a letter typed for a digit next to real digits.
      expect(dreamMatcher('၂၇', LotteryDreamBook.DREAM_1000)(snake)).toBe(true);
      expect(dreamMatcher('ဝ၂၇', LotteryDreamBook.DREAM_1000)(snake)).toBe(
        true,
      );
      // A digit query is a number search only: '၇' is not the letter ရ.
      expect(dreamMatcher('၇')(row('000', null, 'ရထား'))).toBe(false);
      expect(dreamMatcher('၇')(row('700', null, 'ရထား'))).toBe(true);
    });

    it('pads for both books when no book is given', () => {
      const hits = dreamMatcher('7');
      expect(hits(row('007', 'Seven', null))).toBe(true);
      expect(hits(row('07', 'Seven', null, LotteryDreamBook.DREAM_100))).toBe(
        true,
      );
      expect(hits(row('700', 'Lots', null))).toBe(true);
      expect(hits(snake)).toBe(false);
    });

    it('matches nothing for a blank search and never reads a missing name', () => {
      expect(dreamMatcher('   ')(snake)).toBe(false);
      expect(dreamMatcher('pig')(pig)).toBe(false);
    });
  });

  describe('dreamFilterWhere', () => {
    it('maps the admin to-do filters', () => {
      expect(dreamFilterWhere(undefined)).toEqual({});
      expect(dreamFilterWhere('all')).toEqual({});
      expect(dreamFilterWhere('missing_name')).toEqual({
        OR: [{ nameEn: null }, { nameMy: null }],
      });
      expect(dreamFilterWhere('missing_picture')).toEqual({
        pictureUrl: null,
      });
      expect(dreamFilterWhere('inactive')).toEqual({ isActive: false });
    });
  });

  describe('listPublic', () => {
    it('reads one book, only rows customers may see, by number', async () => {
      prisma.lotteryDream.findMany.mockResolvedValue([
        makeDream({ pictureUrl: 'STORED/images/lottery/a.webp' }),
      ]);

      const result = await service.listPublic({ book: '1000' });

      expect(prisma.lotteryDream.findMany).toHaveBeenCalledWith({
        where: { book: LotteryDreamBook.DREAM_1000, AND: [SHOWN] },
        orderBy: { number: 'asc' },
      });
      expect(result).toEqual({
        items: [
          {
            id: DREAM_ID,
            book: '1000',
            number: '027',
            nameEn: 'Snake',
            nameMy: 'မြွေ',
            pictureUrl: 'REQUEST/images/lottery/a.webp',
          },
        ],
      });
      expect(result.items[0]).not.toHaveProperty('isActive');
    });

    it('searches the book in memory, by spelling, not in the where', async () => {
      prisma.lotteryDream.findMany.mockResolvedValue([
        makeDream({ number: '07', book: LotteryDreamBook.DREAM_100 }),
        makeDream({
          id: 'other',
          number: '08',
          book: LotteryDreamBook.DREAM_100,
          nameEn: 'Pig',
          nameMy: 'ဝက်',
        }),
      ]);

      const result = await service.listPublic({ book: '100', q: '၀က်' });

      const { where } = prisma.lotteryDream.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(where.AND).toEqual([SHOWN]);
      expect(result.items.map((item) => item.number)).toEqual(['08']);
    });
  });

  describe('findPublic', () => {
    it('looks the number up padded for its book', async () => {
      prisma.lotteryDream.findUnique.mockResolvedValue(makeDream());

      const result = await service.findPublic('1000', '27');

      expect(prisma.lotteryDream.findUnique).toHaveBeenCalledWith({
        where: {
          book_number: { book: LotteryDreamBook.DREAM_1000, number: '027' },
        },
      });
      expect(result).toMatchObject({ book: '1000', number: '027' });
    });

    it.each([
      ['an unknown book', '10', '27', makeDream()],
      ['a number outside the book', '100', '123', makeDream()],
      ['a missing row', '1000', '27', null],
      ['a switched-off dream', '1000', '27', makeDream({ isActive: false })],
      [
        'an unnamed dream',
        '1000',
        '27',
        makeDream({ nameEn: null, nameMy: null }),
      ],
    ])('404s %s', async (_case, book, number, row) => {
      prisma.lotteryDream.findUnique.mockResolvedValue(row);
      const error = await codedError(service.findPublic(book, number));
      expect(error.getStatus()).toBe(404);
      expect(error.code).toBe(LOTTERY_DREAM_ERRORS.NOT_FOUND);
    });

    it('never queries for a book or number that cannot exist', async () => {
      await codedError(service.findPublic('1000', 'abc'));
      await codedError(service.findPublic('5', '1'));
      expect(prisma.lotteryDream.findUnique).not.toHaveBeenCalled();
    });

    it('shows a dream that has only one of its names', async () => {
      prisma.lotteryDream.findUnique.mockResolvedValue(
        makeDream({ nameEn: null }),
      );
      await expect(service.findPublic('1000', '027')).resolves.toMatchObject({
        nameEn: null,
        nameMy: 'မြွေ',
      });
    });
  });

  describe('listAdmin', () => {
    it('pages both books with the filter, in the contract envelope', async () => {
      prisma.lotteryDream.findMany.mockResolvedValue([
        makeDream({ isActive: false }),
      ]);
      prisma.lotteryDream.count.mockResolvedValue(120);

      const result = await service.listAdmin({
        filter: 'inactive',
        page: 3,
        pageSize: 50,
      });

      expect(prisma.lotteryDream.findMany).toHaveBeenCalledWith({
        where: { AND: [{ isActive: false }] },
        orderBy: [{ book: 'asc' }, { number: 'asc' }],
        skip: 100,
        take: 50,
      });
      expect(prisma.lotteryDream.count).toHaveBeenCalledWith({
        where: { AND: [{ isActive: false }] },
      });
      expect(result).toEqual({
        items: [expect.objectContaining({ id: DREAM_ID, isActive: false })],
        total: 120,
        page: 3,
        pageSize: 50,
      });
    });

    it('with a search, reads the filtered rows once and pages the spelling matches itself', async () => {
      const rows = Array.from({ length: 7 }, (_, i) =>
        makeDream({
          id: `d${i}`,
          number: `10${i}`,
          nameEn: i % 2 ? 'Snake' : 'Pig',
          nameMy: i % 2 ? 'မြွေ' : 'ဝက်',
        }),
      );
      prisma.lotteryDream.findMany.mockResolvedValue(rows);

      const result = await service.listAdmin({
        book: '1000',
        q: '၀က်',
        page: 2,
        pageSize: 2,
      });

      expect(prisma.lotteryDream.findMany).toHaveBeenCalledWith({
        where: { book: LotteryDreamBook.DREAM_1000, AND: [{}] },
        orderBy: [{ book: 'asc' }, { number: 'asc' }],
      });
      expect(prisma.lotteryDream.count).not.toHaveBeenCalled();
      // Pigs are rows 0, 2, 4, 6 → page 2 of 2 is rows 4 and 6.
      expect(result).toEqual({
        items: [
          expect.objectContaining({ id: 'd4' }),
          expect.objectContaining({ id: 'd6' }),
        ],
        total: 4,
        page: 2,
        pageSize: 2,
      });
    });

    it('narrows to one book and defaults the page', async () => {
      await service.listAdmin({ book: '100' });
      expect(prisma.lotteryDream.findMany).toHaveBeenCalledWith({
        where: { book: LotteryDreamBook.DREAM_100, AND: [{}] },
        orderBy: [{ book: 'asc' }, { number: 'asc' }],
        skip: 0,
        take: 50,
      });
    });
  });

  describe('update', () => {
    it('404s an unknown id before writing', async () => {
      prisma.lotteryDream.findUnique.mockResolvedValue(null);
      const error = await codedError(
        service.update(DREAM_ID, { nameEn: 'x' }, actor),
      );
      expect(error.getStatus()).toBe(404);
      expect(prisma.lotteryDream.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('writes only the fields sent, stores the picture canonical, audits before/after', async () => {
      const before = makeDream();
      prisma.lotteryDream.findUnique.mockResolvedValue(before);
      prisma.lotteryDream.update.mockImplementation(
        ({ data }: { data: Partial<LotteryDream> }) =>
          Promise.resolve(makeDream({ ...before, ...data })),
      );

      const result = await service.update(
        DREAM_ID,
        {
          nameMy: null,
          pictureUrl: 'REQUEST/images/lottery/a.webp',
          isActive: false,
        },
        actor,
      );

      expect(prisma.lotteryDream.update).toHaveBeenCalledWith({
        where: { id: DREAM_ID },
        data: {
          nameMy: null,
          pictureUrl: 'STORED/images/lottery/a.webp',
          isActive: false,
        },
      });
      expect(audit.record).toHaveBeenCalledWith({
        action: 'lottery_dream.update',
        actor,
        target: { type: 'lottery_dream', id: DREAM_ID, label: '1000/027' },
        before: {
          book: 'DREAM_1000',
          number: '027',
          nameEn: 'Snake',
          nameMy: 'မြွေ',
          pictureUrl: null,
          isActive: true,
        },
        after: {
          book: 'DREAM_1000',
          number: '027',
          nameEn: 'Snake',
          nameMy: null,
          pictureUrl: 'STORED/images/lottery/a.webp',
          isActive: false,
        },
        metadata: { book: '1000', number: '027' },
      });
      expect(result).toEqual({
        id: DREAM_ID,
        book: '1000',
        number: '027',
        nameEn: 'Snake',
        nameMy: null,
        pictureUrl: 'REQUEST/images/lottery/a.webp',
        isActive: false,
      });
    });

    it('leaves the picture alone when the body does not mention it', async () => {
      prisma.lotteryDream.findUnique.mockResolvedValue(makeDream());
      prisma.lotteryDream.update.mockResolvedValue(
        makeDream({ nameEn: 'Cobra' }),
      );

      await service.update(DREAM_ID, { nameEn: 'Cobra' }, actor);

      expect(prisma.lotteryDream.update).toHaveBeenCalledWith({
        where: { id: DREAM_ID },
        data: { nameEn: 'Cobra' },
      });
      expect(minio.canonicalImageUrl).not.toHaveBeenCalled();
    });

    it('clears the picture on null (Prisma would read undefined as "keep")', async () => {
      prisma.lotteryDream.findUnique.mockResolvedValue(
        makeDream({ pictureUrl: 'STORED/images/lottery/a.webp' }),
      );
      prisma.lotteryDream.update.mockResolvedValue(
        makeDream({ pictureUrl: null }),
      );

      const result = await service.update(
        DREAM_ID,
        { pictureUrl: null },
        actor,
      );

      expect(minio.canonicalImageUrl).toHaveBeenCalledWith(null);
      const { data } = prisma.lotteryDream.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).toEqual({ pictureUrl: null });
      expect(data.pictureUrl).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: expect.objectContaining({
            pictureUrl: 'STORED/images/lottery/a.webp',
          }),
          after: expect.objectContaining({ pictureUrl: null }),
        }),
      );
      expect(result.pictureUrl).toBeNull();
    });
  });

  describe('import', () => {
    const existing = [
      {
        id: 'd-027',
        book: 'DREAM_1000',
        number: '027',
        nameEn: null,
        nameMy: null,
      },
      {
        id: 'd-028',
        book: 'DREAM_1000',
        number: '028',
        nameEn: 'Dog',
        nameMy: 'ခွေး',
      },
      {
        id: 'd-07',
        book: 'DREAM_100',
        number: '07',
        nameEn: 'Snake',
        nameMy: null,
      },
    ];

    const csv = Buffer.from(
      [
        '﻿book,number,name_en,name_my',
        '1000,27,Snake,',
        '',
        '100,7,,မြွေ',
        '1000,028,Dog,ခွေး',
        '1000,027,Cobra,',
        '2000,1,x,y',
        '1000,1234,x,y',
        '100,8,x,y',
      ].join('\r\n'),
    );

    beforeEach(() => {
      prisma.lotteryDream.findMany.mockResolvedValue(existing);
      prisma.lotteryDream.update.mockResolvedValue(makeDream());
    });

    it('pads numbers, leaves blank cells alone, skips unchanged rows and reports bad rows by number', async () => {
      const result = await service.import(csv, 'dreams.csv', true, actor);

      expect(result).toEqual({
        total: 7,
        updated: 2,
        unchanged: 1,
        errors: [
          { row: 6, message: '1000 027 appears more than once in the file.' },
          { row: 7, message: 'Unknown book "2000". Use 1000 or 100.' },
          {
            row: 8,
            message: '"1234" is not a number of the 1000 book (3 digits).',
          },
          { row: 9, message: '100 08 does not exist.' },
        ],
      });
    });

    it('dryRun writes nothing — no rows, no audit', async () => {
      await service.import(csv, 'dreams.csv', true, actor);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.lotteryDream.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('applies the changed rows and the audit line in one transaction', async () => {
      const result = await service.import(csv, 'dreams.csv', false, actor);

      expect(result).toMatchObject({ total: 7, updated: 2, unchanged: 1 });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.lotteryDream.update.mock.calls.map((c) => c[0])).toEqual([
        { where: { id: 'd-027' }, data: { nameEn: 'Snake' } },
        { where: { id: 'd-07' }, data: { nameMy: 'မြွေ' } },
      ]);
      expect(audit.record).toHaveBeenCalledWith({
        action: 'lottery_dream.import',
        actor,
        target: { type: 'lottery_dream', id: null, label: 'dreams.csv' },
        metadata: {
          fileName: 'dreams.csv',
          total: 7,
          updated: 2,
          unchanged: 1,
          errors: 4,
        },
        tx: prisma,
      });
    });

    it('refuses an over-long name on its row and keeps going', async () => {
      const long = 'x'.repeat(121);
      const result = await service.import(
        Buffer.from(`book,number,name_en\n1000,27,${long}\n1000,28,Dog\n`),
        'dreams.csv',
        true,
        actor,
      );
      expect(result).toEqual({
        total: 2,
        updated: 0,
        unchanged: 1,
        errors: [{ row: 2, message: 'A name is longer than 120 characters.' }],
      });
    });

    it('400s a sheet without the right columns before reading the rows', async () => {
      const error = await codedError(
        service.import(Buffer.from('a,b\n1,2\n'), 'x.csv', false, actor),
      );
      expect(error.getStatus()).toBe(400);
      expect(prisma.lotteryDream.findMany).not.toHaveBeenCalled();
    });
  });

  describe('export', () => {
    it('writes every row of one book as an .xlsx the import reads back', async () => {
      prisma.lotteryDream.findMany.mockResolvedValue([
        makeDream({
          number: '00',
          book: LotteryDreamBook.DREAM_100,
          nameMy: null,
          pictureUrl: 'STORED/images/lottery/a.webp',
        }),
        makeDream({
          number: '01',
          book: LotteryDreamBook.DREAM_100,
          nameEn: null,
          nameMy: null,
          isActive: false,
        }),
      ]);

      const file = await service.export('100');

      expect(prisma.lotteryDream.findMany).toHaveBeenCalledWith({
        where: { book: LotteryDreamBook.DREAM_100 },
        orderBy: { number: 'asc' },
      });
      expect(isXlsxBuffer(file)).toBe(true);
      const sheet = await parseDreamSheet(file);
      expect(sheet.rows).toEqual([
        {
          row: 2,
          cells: {
            book: '100',
            number: '00',
            name_en: 'Snake',
            has_picture: 'yes',
            is_active: 'yes',
          },
        },
        {
          row: 3,
          cells: {
            book: '100',
            number: '01',
            has_picture: 'no',
            is_active: 'no',
          },
        },
      ]);
    });
  });
});
