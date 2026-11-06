import { Test, TestingModule } from '@nestjs/testing';
import { ClientPlatform } from '../generated/prisma/client';
import { AdDecisionService } from './ad-decision.service';
import { AdsController } from './ads.controller';

describe('AdsController', () => {
  let controller: AdsController;
  let decisions: Record<
    'session' | 'preroll' | 'midroll' | 'recordEvent',
    jest.Mock
  >;
  const user = { id: 'u1', username: 'viewer', role: 'USER' } as never;
  const viewer = {
    userId: 'u1',
    role: 'USER',
    movieId: 'm1',
    platform: ClientPlatform.UNKNOWN,
  };

  beforeEach(async () => {
    decisions = {
      session: jest.fn().mockResolvedValue({
        preroll: null,
        breaks: null,
        corner: null,
      }),
      preroll: jest.fn().mockResolvedValue({ ad: null, replayAfterMinutes: 0 }),
      midroll: jest.fn().mockResolvedValue({ ad: null }),
      recordEvent: jest
        .fn()
        .mockResolvedValue({ playbackId: 'pb', status: 'STARTED' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdsController],
      providers: [{ provide: AdDecisionService, useValue: decisions }],
    }).compile();
    controller = module.get(AdsController);
  });

  it('opens a session for the signed-in viewer, platform from the request context', async () => {
    await expect(
      controller.session({ movieId: 'm1' }, user),
    ).resolves.toMatchObject({ preroll: null, breaks: null, corner: null });
    expect(decisions.session).toHaveBeenCalledWith(viewer);
  });

  it('keeps the legacy pre-roll route', async () => {
    await expect(controller.decide({ movieId: 'm1' }, user)).resolves.toEqual({
      ad: null,
      replayAfterMinutes: 0,
    });
    expect(decisions.preroll).toHaveBeenCalledWith(viewer);
  });

  it('decides one break', async () => {
    await controller.midroll({ movieId: 'm1', breakAtSeconds: 1800 }, user);
    expect(decisions.midroll).toHaveBeenCalledWith({
      ...viewer,
      breakAtSeconds: 1800,
    });
  });

  it('records an event for the viewer’s own playback', async () => {
    await controller.event('pb', { event: 'clicked' }, user);
    expect(decisions.recordEvent).toHaveBeenCalledWith(
      'pb',
      'u1',
      'clicked',
      undefined,
    );
  });
});
