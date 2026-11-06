import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, Role } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { MinioService } from '../common/storage/minio.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  LOTTERY_SETTINGS_LOCK_NAMESPACE,
  LotterySettingsService,
  staffLabel,
  type LotterySettingsRow,
} from './lottery-settings.service';

type RawCall = [TemplateStringsArray, ...unknown[]];

const admin = {
  id: 'admin-1',
  username: 'admin.blake',
  role: Role.ADMIN,
  appRoleId: null,
};

function makeSettings(
  overrides: Partial<LotterySettingsRow> = {},
): LotterySettingsRow {
  return {
    id: 'settings-1',
    ticketPrice: new Prisma.Decimal(1000),
    maxPerNumber: 20,
    exchangeRate: new Prisma.Decimal(75),
    salesCloseMinutesBefore: 60,
    frameUrl: null,
    resultsUrl: null,
    resultsSourceKind: 'thai_lotto_json',
    claimDeadlineDays: 90,
    updatedByUserId: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  };
}

describe('LotterySettingsService', () => {
  let service: LotterySettingsService;
  let prisma: {
    lotterySettings: Record<'findFirst' | 'create' | 'update', jest.Mock>;
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      lotterySettings: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      // The interactive transaction hands the same mock back as `tx`.
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LotterySettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        {
          provide: MinioService,
          useValue: {
            imageUrl: jest.fn((url: string | null) =>
              url ? url.replace('STORED', 'REQUEST') : null,
            ),
            canonicalImageUrl: jest.fn((url: string | null) =>
              url ? url.replace('REQUEST', 'STORED') : url,
            ),
          },
        },
      ],
    }).compile();
    service = module.get(LotterySettingsService);
  });

  describe('getOrCreate', () => {
    it('returns the existing row without a transaction', async () => {
      const row = makeSettings();
      prisma.lotterySettings.findFirst.mockResolvedValue(row);
      await expect(service.getOrCreate()).resolves.toBe(row);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates the row with the schema defaults under the singleton lock', async () => {
      const created = makeSettings();
      prisma.lotterySettings.findFirst.mockResolvedValue(null);
      prisma.lotterySettings.create.mockResolvedValue(created);

      await expect(service.getOrCreate()).resolves.toBe(created);

      const [strings, key] = prisma.$executeRaw.mock.calls[0] as RawCall;
      expect(strings.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))');
      expect(key).toBe(LOTTERY_SETTINGS_LOCK_NAMESPACE);
      expect(prisma.lotterySettings.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} }),
      );
    });

    it('uses the row another request created while we waited for the lock', async () => {
      const raced = makeSettings();
      prisma.lotterySettings.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raced);
      await expect(service.getOrCreate()).resolves.toBe(raced);
      expect(prisma.lotterySettings.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes nothing — and audits nothing — when nothing changes', async () => {
      prisma.lotterySettings.findFirst.mockResolvedValue(makeSettings());
      const view = await service.update(
        { ticketPrice: 1000, maxPerNumber: 20 },
        admin,
      );
      expect(view.ticketPrice).toBe(1000);
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('saves only the changed fields, stamps the actor and audits before/after in one transaction', async () => {
      const current = makeSettings();
      const saved = makeSettings({
        ticketPrice: new Prisma.Decimal(1500),
        salesCloseMinutesBefore: 90,
        updatedByUserId: admin.id,
        updatedBy: { id: admin.id, username: admin.username, displayName: '' },
      });
      prisma.lotterySettings.findFirst.mockResolvedValue(current);
      prisma.lotterySettings.update.mockResolvedValue(saved);

      const view = await service.update(
        { ticketPrice: 1500, maxPerNumber: 20, salesCloseMinutesBefore: 90 },
        admin,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'settings-1' },
          data: {
            ticketPrice: 1500,
            salesCloseMinutesBefore: 90,
            updatedBy: { connect: { id: admin.id } },
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_settings.update',
          actor: admin,
          target: expect.objectContaining({
            type: 'lottery_settings',
            id: 'settings-1',
          }),
          before: expect.objectContaining({ ticketPrice: 1000 }),
          after: expect.objectContaining({
            ticketPrice: 1500,
            salesCloseMinutesBefore: 90,
          }),
          tx: prisma,
        }),
      );
      expect(view).toEqual({
        ticketPrice: 1500,
        maxPerNumber: 20,
        exchangeRate: 75,
        salesCloseMinutesBefore: 90,
        frameUrl: null,
        resultsUrl: null,
        resultsSourceKind: 'thai_lotto_json',
        claimDeadlineDays: 90,
        updatedAt: saved.updatedAt,
        // A blank display name falls back to the username (admin naming rule).
        updatedBy: { id: admin.id, label: admin.username },
      });
    });

    it('saves a new prize claim deadline, audits it with the other fields, and treats the same value as unchanged', async () => {
      prisma.lotterySettings.findFirst.mockResolvedValue(makeSettings());
      prisma.lotterySettings.update.mockResolvedValue(
        makeSettings({ claimDeadlineDays: 120 }),
      );

      const view = await service.update({ claimDeadlineDays: 120 }, admin);

      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            claimDeadlineDays: 120,
            updatedBy: { connect: { id: admin.id } },
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lottery_settings.update',
          before: expect.objectContaining({ claimDeadlineDays: 90 }),
          after: expect.objectContaining({ claimDeadlineDays: 120 }),
        }),
      );
      expect(view.claimDeadlineDays).toBe(120);

      prisma.lotterySettings.update.mockClear();
      audit.record.mockClear();
      await service.update({ claimDeadlineDays: 90 }, admin);
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('stores a new ticket frame canonical and reads it back re-hosted', async () => {
      const current = makeSettings();
      const saved = makeSettings({
        frameUrl: 'http://STORED/movies/images/lottery_frame/f.png',
      });
      prisma.lotterySettings.findFirst.mockResolvedValue(current);
      prisma.lotterySettings.update.mockResolvedValue(saved);

      const view = await service.update(
        { frameUrl: 'http://REQUEST/movies/images/lottery_frame/f.png' },
        admin,
      );

      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            frameUrl: 'http://STORED/movies/images/lottery_frame/f.png',
            updatedBy: { connect: { id: admin.id } },
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: expect.objectContaining({ frameUrl: null }),
          after: expect.objectContaining({
            frameUrl: 'http://STORED/movies/images/lottery_frame/f.png',
          }),
        }),
      );
      expect(view.frameUrl).toBe(
        'http://REQUEST/movies/images/lottery_frame/f.png',
      );
    });

    it('treats the same frame echoed back under another host as unchanged, and null as "back to the built-in frame"', async () => {
      const withFrame = makeSettings({
        frameUrl: 'http://STORED/movies/images/lottery_frame/f.png',
      });
      prisma.lotterySettings.findFirst.mockResolvedValue(withFrame);

      await service.update(
        { frameUrl: 'http://REQUEST/movies/images/lottery_frame/f.png' },
        admin,
      );
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();

      prisma.lotterySettings.update.mockResolvedValue(makeSettings());
      const view = await service.update({ frameUrl: null }, admin);
      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { frameUrl: null, updatedBy: { connect: { id: admin.id } } },
        }),
      );
      expect(view.frameUrl).toBeNull();
    });
  });

  describe('results source (phase 3)', () => {
    it('stores a results URL, clears it on null, and treats the same URL as unchanged', async () => {
      prisma.lotterySettings.findFirst.mockResolvedValue(makeSettings());
      prisma.lotterySettings.update.mockResolvedValue(
        makeSettings({ resultsUrl: 'https://lotto.example/{date}' }),
      );

      const view = await service.update(
        { resultsUrl: 'https://lotto.example/{date}' },
        admin,
      );
      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            resultsUrl: 'https://lotto.example/{date}',
            updatedBy: { connect: { id: admin.id } },
          },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: expect.objectContaining({ resultsUrl: null }),
          after: expect.objectContaining({
            resultsUrl: 'https://lotto.example/{date}',
          }),
        }),
      );
      expect(view.resultsUrl).toBe('https://lotto.example/{date}');
      expect(view.resultsSourceKind).toBe('thai_lotto_json');

      prisma.lotterySettings.findFirst.mockResolvedValue(
        makeSettings({ resultsUrl: 'https://lotto.example/{date}' }),
      );
      prisma.lotterySettings.update.mockClear();
      await service.update(
        { resultsUrl: 'https://lotto.example/{date}' },
        admin,
      );
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();

      prisma.lotterySettings.update.mockResolvedValue(makeSettings());
      const cleared = await service.update({ resultsUrl: null }, admin);
      expect(prisma.lotterySettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { resultsUrl: null, updatedBy: { connect: { id: admin.id } } },
        }),
      );
      expect(cleared.resultsUrl).toBeNull();
    });

    it('400s a results URL that is not absolute http(s), writing nothing', async () => {
      prisma.lotterySettings.findFirst.mockResolvedValue(makeSettings());
      await expect(
        service.update({ resultsUrl: 'https://' }, admin),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.update({ resultsUrl: 'file:///etc/hosts' }, admin),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();
    });

    it('400s a results URL on this machine, the LAN or a private address, writing nothing', async () => {
      prisma.lotterySettings.findFirst.mockResolvedValue(makeSettings());
      for (const resultsUrl of [
        'http://127.0.0.1:9000/x',
        'http://10.0.0.5/',
        'http://localhost/',
        'http://localhost:3000/api/lottery',
        'http://api.localhost/',
        'http://minio.local/',
        'http://192.168.1.20/',
        'http://172.20.0.3/',
        'http://169.254.169.254/',
        'http://100.64.0.1/',
        'http://0.0.0.0/',
        'http://[::1]/',
        'http://[fd12::1]/',
        'http://[fe80::1]/',
        'http://[::ffff:10.0.0.1]/',
      ]) {
        await expect(
          service.update({ resultsUrl }, admin),
        ).rejects.toMatchObject({
          status: 400,
          message: 'resultsUrl must point at a public host',
        });
      }
      expect(prisma.lotterySettings.update).not.toHaveBeenCalled();
      // A public host, by name or by address, is fine.
      prisma.lotterySettings.update.mockResolvedValue(
        makeSettings({ resultsUrl: 'http://203.0.113.9/latest' }),
      );
      await expect(
        service.update({ resultsUrl: 'http://203.0.113.9/latest' }, admin),
      ).resolves.toMatchObject({ resultsUrl: 'http://203.0.113.9/latest' });
    });
  });

  it('names staff by display name, else username', () => {
    expect(staffLabel({ id: 'a', username: 'u', displayName: ' Blake ' })).toBe(
      'Blake',
    );
    expect(staffLabel({ id: 'a', username: 'u', displayName: null })).toBe('u');
  });
});
