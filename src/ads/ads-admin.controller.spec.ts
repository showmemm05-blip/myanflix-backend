import { Test, TestingModule } from '@nestjs/testing';
import { PermissionsGuard } from '../roles/guards/permissions.guard';
import { AdAnalyticsService } from './ad-analytics.service';
import { AdImageService } from './ad-image.service';
import { AdSettingsService } from './ad-settings.service';
import { AdVideoService } from './ad-video.service';
import { AdsAdminController } from './ads-admin.controller';
import { AdsAdminService } from './ads-admin.service';

describe('AdsAdminController', () => {
  let controller: AdsAdminController;
  let ads: Record<
    'list' | 'findOne' | 'create' | 'update' | 'remove',
    jest.Mock
  >;
  let video: { attach: jest.Mock };
  let image: { attach: jest.Mock };
  let analytics: Record<'overview' | 'ads' | 'byDate', jest.Mock>;
  let settings: Record<'get' | 'update', jest.Mock>;
  const actor = { id: 'staff-1', username: 'staff', role: 'ADMIN' } as never;

  beforeEach(async () => {
    ads = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 25 }),
      findOne: jest.fn().mockResolvedValue({ id: 'ad-1' }),
      create: jest.fn().mockResolvedValue({ id: 'ad-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ad-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    video = { attach: jest.fn().mockResolvedValue(undefined) };
    image = { attach: jest.fn().mockResolvedValue({ id: 'ad-1' }) };
    settings = {
      get: jest.fn().mockResolvedValue({ midrollIntervalMinutes: 0 }),
      update: jest.fn().mockResolvedValue({ midrollIntervalMinutes: 30 }),
    };
    analytics = {
      overview: jest.fn().mockResolvedValue({}),
      ads: jest.fn().mockResolvedValue({ items: [] }),
      byDate: jest.fn().mockResolvedValue({ buckets: [] }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdsAdminController],
      providers: [
        { provide: AdsAdminService, useValue: ads },
        { provide: AdVideoService, useValue: video },
        { provide: AdImageService, useValue: image },
        { provide: AdAnalyticsService, useValue: analytics },
        { provide: AdSettingsService, useValue: settings },
      ],
    })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(AdsAdminController);
  });

  it('attaches the staged video, then answers with the ad as the list shows it', async () => {
    await expect(
      controller.attachVideo('ad-1', { relativePath: 'video.mp4' }, actor),
    ).resolves.toEqual({ id: 'ad-1' });
    expect(video.attach).toHaveBeenCalledWith(
      'ad-1',
      { relativePath: 'video.mp4' },
      actor,
    );
    expect(ads.findOne).toHaveBeenCalledWith('ad-1');
  });

  it('hands a corner picture to the image service', async () => {
    const file = { buffer: Buffer.from('GIF89a') } as Express.Multer.File;
    await expect(controller.attachImage('ad-1', file, actor)).resolves.toEqual({
      id: 'ad-1',
    });
    expect(image.attach).toHaveBeenCalledWith('ad-1', file, actor);
  });

  it('reads and saves the playback rules', async () => {
    await expect(controller.getSettings()).resolves.toEqual({
      midrollIntervalMinutes: 0,
    });
    const rules = {
      adsEnabled: true,
      midrollIntervalMinutes: 30,
      duringMovieAudience: 'ALL' as const,
    };
    await controller.updateSettings(rules, actor);
    expect(settings.update).toHaveBeenCalledWith(rules, actor);
  });

  it('hands the rest straight to the services', async () => {
    await controller.list({ page: 2, limit: 10 });
    expect(ads.list).toHaveBeenCalledWith({ page: 2, limit: 10 });
    await controller.create({ title: 'x' } as never, actor);
    expect(ads.create).toHaveBeenCalledWith({ title: 'x' }, actor);
    await controller.update('ad-1', { priority: 3 }, actor);
    expect(ads.update).toHaveBeenCalledWith('ad-1', { priority: 3 }, actor);
    await controller.remove('ad-1', actor);
    expect(ads.remove).toHaveBeenCalledWith('ad-1', actor);
    await controller.byDate({ from: '2026-11-01', to: '2026-11-02' });
    expect(analytics.byDate).toHaveBeenCalledWith({
      from: '2026-11-01',
      to: '2026-11-02',
    });
  });
});
