import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AD_SETTINGS_CACHE_MS, AdSettingsService } from './ad-settings.service';
import { UpdateAdSettingsDto } from './dto/ad-settings.dto';

const actor = { id: 'staff-1', username: 'staff', role: 'ADMIN' } as never;

const RULES = {
  adsEnabled: true,
  midrollIntervalMinutes: 0,
  duringMovieAudience: 'ALL',
} as const;

describe('AdSettingsService', () => {
  let service: AdSettingsService;
  let prisma: {
    adSettings: Record<'findFirst' | 'create' | 'update', jest.Mock>;
    advertisement: { findMany: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = {
      adSettings: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 's1',
            ...data,
          }),
        ),
        update: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: 's1',
            ...data,
          }),
        ),
      },
      advertisement: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(AdSettingsService);
  });

  it('falls back to the defaults before the first save (ads on, no breaks, everyone)', async () => {
    await expect(service.get()).resolves.toEqual({
      ...RULES,
      updatedAt: null,
      updatedBy: null,
      liveCounts: { preroll: 0, breaks: 0, corner: 0 },
    });
    await expect(service.rules()).resolves.toEqual(RULES);
  });

  it('counts the live ads per slot for the preview', async () => {
    prisma.advertisement.findMany.mockResolvedValue([
      { format: 'VIDEO', playsBeforeMovie: true, playsAtBreaks: true },
      { format: 'VIDEO', playsBeforeMovie: false, playsAtBreaks: true },
      { format: 'CORNER', playsBeforeMovie: false, playsAtBreaks: false },
    ]);
    const view = await service.get();
    expect(view.liveCounts).toEqual({ preroll: 1, breaks: 2, corner: 1 });
  });

  it('creates the row on the first save, under the lock, with an audit row', async () => {
    await service.update({ ...RULES, midrollIntervalMinutes: 30 }, actor);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.adSettings.create).toHaveBeenCalledWith({
      data: {
        ...RULES,
        midrollIntervalMinutes: 30,
        updatedByUserId: 'staff-1',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'advertisement_settings.update',
        before: RULES,
        after: {
          ...RULES,
          midrollIntervalMinutes: 30,
        },
      }),
    );
  });

  it('updates the existing row on later saves', async () => {
    prisma.adSettings.findFirst.mockResolvedValue({ id: 's1', ...RULES });
    await service.update(
      { ...RULES, adsEnabled: false, duringMovieAudience: 'NON_PREMIUM' },
      actor,
    );
    expect(prisma.adSettings.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        ...RULES,
        adsEnabled: false,
        duringMovieAudience: 'NON_PREMIUM',
        updatedByUserId: 'staff-1',
      },
    });
  });

  it('caches the rules for the decisions, and a save clears the cache at once', async () => {
    prisma.adSettings.findFirst.mockResolvedValue({
      ...RULES,
      midrollIntervalMinutes: 5,
    });
    await expect(service.rules(1_000)).resolves.toMatchObject({
      midrollIntervalMinutes: 5,
    });
    prisma.adSettings.findFirst.mockResolvedValue({
      ...RULES,
      midrollIntervalMinutes: 9,
    });
    await expect(
      service.rules(1_000 + AD_SETTINGS_CACHE_MS - 1),
    ).resolves.toMatchObject({
      midrollIntervalMinutes: 5,
    });
    await expect(
      service.rules(1_000 + AD_SETTINGS_CACHE_MS),
    ).resolves.toMatchObject({
      midrollIntervalMinutes: 9,
    });
    prisma.adSettings.findFirst.mockResolvedValue({ id: 's1', ...RULES });
    await service.update({ ...RULES, midrollIntervalMinutes: 2 }, actor);
    prisma.adSettings.findFirst.mockResolvedValue({
      ...RULES,
      midrollIntervalMinutes: 2,
    });
    await expect(
      service.rules(1_000 + AD_SETTINGS_CACHE_MS + 1),
    ).resolves.toMatchObject({
      midrollIntervalMinutes: 2,
    });
  });
});

describe('UpdateAdSettingsDto', () => {
  const problems = async (body: object) =>
    (await validate(plainToInstance(UpdateAdSettingsDto, body))).map(
      (e) => e.property,
    );

  it('needs every field, in range', async () => {
    expect(await problems(RULES)).toEqual([]);
    expect(await problems({ ...RULES, midrollIntervalMinutes: 1 })).toEqual([]);
    expect(await problems({ ...RULES, midrollIntervalMinutes: 240 })).toEqual(
      [],
    );
    expect(await problems({ ...RULES, midrollIntervalMinutes: 241 })).toEqual([
      'midrollIntervalMinutes',
    ]);
    expect(await problems({ ...RULES, midrollIntervalMinutes: 0.5 })).toEqual([
      'midrollIntervalMinutes',
    ]);
    expect(await problems({ ...RULES, duringMovieAudience: 'SOME' })).toEqual([
      'duringMovieAudience',
    ]);
    expect(await problems({ ...RULES, adsEnabled: 'yes' })).toEqual([
      'adsEnabled',
    ]);
    expect(await problems({})).toEqual([
      'adsEnabled',
      'midrollIntervalMinutes',
      'duringMovieAudience',
    ]);
  });
});
