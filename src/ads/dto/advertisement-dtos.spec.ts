import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminAdQueryDto,
  CreateAdvertisementDto,
  UpdateAdvertisementDto,
} from './advertisement.dto';
import { AdPlaybackEventDto, MidrollRequestDto } from './ad-preroll.dto';

async function problems(instance: object): Promise<string[]> {
  return (
    await validate(instance, { whitelist: true, forbidNonWhitelisted: true })
  ).map((e) => e.property);
}

describe('CreateAdvertisementDto', () => {
  it('accepts the full form', async () => {
    const dto = plainToInstance(CreateAdvertisementDto, {
      title: ' Big match ',
      description: '',
      isActive: 'false',
      startsAt: '2026-11-04T00:00:00.000Z',
      endsAt: null,
      dailyStartTime: '22:00',
      dailyEndTime: '02:00',
      tzOffsetMinutes: 390,
      targetType: 'SELECTED',
      movieIds: ['731798fd-ca56-4650-86b6-32e96169c25e'],
      priority: 10,
      isSkippable: true,
      skipAfterSeconds: 5,
      frequencyLimitMinutes: '',
      maxImpressionsPerUserPerDay: 3,
    });
    expect(await problems(dto)).toEqual([]);
    expect(dto.title).toBe('Big match');
    expect(dto.description).toBeNull();
    expect(dto.isActive).toBe(false);
    expect(dto.frequencyLimitMinutes).toBeNull();
  });

  it('refuses a blank title, a bad hour, a nonsense offset and an out-of-range number', async () => {
    const dto = plainToInstance(CreateAdvertisementDto, {
      title: '   ',
      dailyStartTime: '25:00',
      tzOffsetMinutes: 900,
      priority: 5000,
      skipAfterSeconds: 0,
      movieIds: ['not-a-uuid'],
    });
    expect(await problems(dto)).toEqual(
      expect.arrayContaining([
        'title',
        'dailyStartTime',
        'tzOffsetMinutes',
        'priority',
        'skipAfterSeconds',
        'movieIds',
      ]),
    );
  });
});

describe('UpdateAdvertisementDto', () => {
  it('never takes the type (fixed at creation), but takes the slot and corner fields', async () => {
    expect(
      await problems(
        plainToInstance(UpdateAdvertisementDto, { format: 'CORNER' }),
      ),
    ).toEqual(['format']);
    expect(
      await problems(
        plainToInstance(UpdateAdvertisementDto, {
          playsAtBreaks: true,
          linkUrl: '',
          cornerShowSeconds: null,
          cornerRepeatMinutes: 15,
          cornerClosable: false,
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        plainToInstance(UpdateAdvertisementDto, {
          cornerShowSeconds: 2,
          cornerRepeatMinutes: 241,
        }),
      ),
    ).toEqual(['cornerShowSeconds', 'cornerRepeatMinutes']);
  });

  it('keeps absent fields and refuses a null title', async () => {
    expect(await problems(plainToInstance(UpdateAdvertisementDto, {}))).toEqual(
      [],
    );
    expect(
      await problems(plainToInstance(UpdateAdvertisementDto, { title: null })),
    ).toEqual(['title']);
    expect(
      await problems(
        plainToInstance(UpdateAdvertisementDto, {
          description: null,
          endsAt: '',
        }),
      ),
    ).toEqual([]);
  });
});

describe('AdminAdQueryDto', () => {
  it('defaults the page, caps the size and trims the search', async () => {
    const dto = plainToInstance(AdminAdQueryDto, {
      search: '  match ',
      status: 'LIVE',
    });
    expect(await problems(dto)).toEqual([]);
    expect(dto).toMatchObject({
      page: 1,
      limit: 25,
      search: 'match',
      status: 'LIVE',
    });
    expect(
      await problems(
        plainToInstance(AdminAdQueryDto, { limit: '101', status: 'SOON' }),
      ),
    ).toEqual(expect.arrayContaining(['limit', 'status']));
  });
});

describe('MidrollRequestDto', () => {
  it('takes a break at whole minutes of movie time, from 1:00 to a day', async () => {
    const movieId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const check = async (breakAtSeconds: unknown) =>
      problems(plainToInstance(MidrollRequestDto, { movieId, breakAtSeconds }));
    expect(await check(60)).toEqual([]);
    expect(await check(1800)).toEqual([]);
    expect(await check(86_400)).toEqual([]);
    for (const bad of [0, 59, 90, 1810, 86_460, 1800.5, 'x']) {
      expect(await check(bad)).toEqual(['breakAtSeconds']);
    }
    expect(
      await problems(
        plainToInstance(MidrollRequestDto, {
          movieId: 'nope',
          breakAtSeconds: 60,
        }),
      ),
    ).toEqual(['movieId']);
  });
});

describe('AdPlaybackEventDto', () => {
  it('knows the corner events and bounds the position at a day', async () => {
    for (const event of ['shown', 'clicked']) {
      expect(
        await problems(plainToInstance(AdPlaybackEventDto, { event })),
      ).toEqual([]);
    }
    expect(
      await problems(
        plainToInstance(AdPlaybackEventDto, {
          event: 'skipped',
          positionSeconds: 86_400,
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(
        plainToInstance(AdPlaybackEventDto, {
          event: 'skipped',
          positionSeconds: 86_401,
        }),
      ),
    ).toEqual(['positionSeconds']);
  });

  it('knows the four events and bounds the position', async () => {
    expect(
      await problems(
        plainToInstance(AdPlaybackEventDto, {
          event: 'skipped',
          positionSeconds: 7,
        }),
      ),
    ).toEqual([]);
    expect(
      await problems(plainToInstance(AdPlaybackEventDto, { event: 'paused' })),
    ).toEqual(['event']);
    expect(
      await problems(
        plainToInstance(AdPlaybackEventDto, {
          event: 'failed',
          positionSeconds: -1,
        }),
      ),
    ).toEqual(['positionSeconds']);
  });
});
