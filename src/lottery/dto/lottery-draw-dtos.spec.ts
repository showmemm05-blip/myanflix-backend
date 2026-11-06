import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminDrawQueryDto,
  AdminDrawTicketsQueryDto,
  CreateLotteryDrawDto,
  DrawAvailabilityDto,
  OffSaleNumbersDto,
  UpdateLotteryDrawDto,
} from './lottery-draw.dto';
import { UpdateLotterySettingsDto } from './lottery-settings.dto';

/** The same options as the global ValidationPipe in app.module.ts. */
const TRANSFORM = { enableImplicitConversion: true } as const;

async function errorsOf<T extends object>(
  Dto: new () => T,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(Dto, body, TRANSFORM);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance, fields: errors.map((e) => e.property).sort() };
}

const OWN_IMAGE = 'http://192.168.1.5:9000/movies/images/lottery/abc.webp';
const OWN_FRAME =
  'http://192.168.1.5:9000/movies/images/lottery_frame/frame.png';
const numbers = (count: number) =>
  Array.from({ length: count }, (_, i) => String(i).padStart(6, '0'));

describe('UpdateLotterySettingsDto', () => {
  it('accepts an empty body and every field at once, coercing numeric strings', async () => {
    expect((await errorsOf(UpdateLotterySettingsDto, {})).fields).toEqual([]);
    const { instance, fields } = await errorsOf(UpdateLotterySettingsDto, {
      ticketPrice: '1500',
      maxPerNumber: '10',
      exchangeRate: '75.1234',
      salesCloseMinutesBefore: '0',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      ticketPrice: 1500,
      maxPerNumber: 10,
      exchangeRate: 75.1234,
      salesCloseMinutesBefore: 0,
    });
  });

  it('refuses a free ticket, a zero rate, too many decimals and a gap over a day', async () => {
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { ticketPrice: 0 })).fields,
    ).toEqual(['ticketPrice']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { ticketPrice: 10.005 }))
        .fields,
    ).toEqual(['ticketPrice']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { exchangeRate: 0 })).fields,
    ).toEqual(['exchangeRate']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { exchangeRate: 1.23456 }))
        .fields,
    ).toEqual(['exchangeRate']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { maxPerNumber: 101 })).fields,
    ).toEqual(['maxPerNumber']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { maxPerNumber: 1.5 })).fields,
    ).toEqual(['maxPerNumber']);
    expect(
      (
        await errorsOf(UpdateLotterySettingsDto, {
          salesCloseMinutesBefore: 1441,
        })
      ).fields,
    ).toEqual(['salesCloseMinutesBefore']);
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { foo: 1 })).fields,
    ).toEqual(['foo']);
  });

  it('takes a frame from images/lottery_frame/ only; blank clears it', async () => {
    const own = await errorsOf(UpdateLotterySettingsDto, {
      frameUrl: ` ${OWN_FRAME} `,
    });
    expect(own.fields).toEqual([]);
    expect(own.instance.frameUrl).toBe(OWN_FRAME);

    const cleared = await errorsOf(UpdateLotterySettingsDto, { frameUrl: '' });
    expect(cleared.fields).toEqual([]);
    expect(cleared.instance.frameUrl).toBeNull();
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { frameUrl: null })).instance
        .frameUrl,
    ).toBeNull();

    // Ours, but a dream / draw picture — the wrong folder for a frame.
    expect(
      (await errorsOf(UpdateLotterySettingsDto, { frameUrl: OWN_IMAGE }))
        .fields,
    ).toEqual(['frameUrl']);
    for (const frameUrl of [
      'https://evil.example/frame.png',
      'http://192.168.1.5:9000/other/images/lottery_frame/frame.png',
      'http://192.168.1.5:9000/movies/images/lottery_frame/',
      'ftp://192.168.1.5/movies/images/lottery_frame/frame.png',
      7,
    ]) {
      expect(
        (await errorsOf(UpdateLotterySettingsDto, { frameUrl })).fields,
      ).toEqual(['frameUrl']);
    }
  });
});

describe('DrawAvailabilityDto', () => {
  it('accepts 1..50 distinct six-digit numbers and trims them', async () => {
    const { instance, fields } = await errorsOf(DrawAvailabilityDto, {
      numbers: [' 123456 ', '000001'],
    });
    expect(fields).toEqual([]);
    expect(instance.numbers).toEqual(['123456', '000001']);
    expect(
      (await errorsOf(DrawAvailabilityDto, { numbers: numbers(50) })).fields,
    ).toEqual([]);
  });

  it('refuses an empty list, 51 numbers, a repeat, a short number and a non-list', async () => {
    for (const body of [
      { numbers: [] },
      { numbers: numbers(51) },
      { numbers: ['123456', '123456'] },
      { numbers: ['12345'] },
      { numbers: ['1234567'] },
      { numbers: ['12345a'] },
      { numbers: '123456' },
      {},
    ]) {
      expect((await errorsOf(DrawAvailabilityDto, body)).fields).toEqual([
        'numbers',
      ]);
    }
  });
});

describe('OffSaleNumbersDto', () => {
  it('accepts an empty list (everything back on sale) and up to 1000 numbers', async () => {
    expect((await errorsOf(OffSaleNumbersDto, { numbers: [] })).fields).toEqual(
      [],
    );
    expect(
      (await errorsOf(OffSaleNumbersDto, { numbers: numbers(1000) })).fields,
    ).toEqual([]);
  });

  it('refuses 1001 numbers, a repeat and a bad number', async () => {
    for (const body of [
      { numbers: numbers(1001) },
      { numbers: ['123456', '123456'] },
      { numbers: ['12-456'] },
      {},
    ]) {
      expect((await errorsOf(OffSaleNumbersDto, body)).fields).toEqual([
        'numbers',
      ]);
    }
  });
});

describe('CreateLotteryDrawDto', () => {
  it('needs only a real calendar date; the rest is optional', async () => {
    const { instance, fields } = await errorsOf(CreateLotteryDrawDto, {
      thaiDrawDate: ' 2026-11-01 ',
      salesCloseAt: '',
    });
    expect(fields).toEqual([]);
    expect(instance.thaiDrawDate).toBe('2026-11-01');
    expect(instance.salesCloseAt).toBeUndefined();
    expect(instance.drawNo).toBeUndefined();
    expect(instance.pictureUrl).toBeUndefined();
    // Absent = copy the settings' frame (the service decides), not null.
    expect(instance.frameUrl).toBeUndefined();
  });

  it('takes a draw number, a close time, an own picture and an own frame', async () => {
    const { instance, fields } = await errorsOf(CreateLotteryDrawDto, {
      drawNo: '25',
      thaiDrawDate: '2026-11-01',
      salesCloseAt: '2026-11-01T05:00:00.000Z',
      pictureUrl: OWN_IMAGE,
      frameUrl: OWN_FRAME,
    });
    expect(fields).toEqual([]);
    expect(instance.drawNo).toBe(25);
    expect(instance.salesCloseAt).toBe('2026-11-01T05:00:00.000Z');
    expect(instance.frameUrl).toBe(OWN_FRAME);
  });

  it('refuses a picture in the frame slot and a frame in the picture slot; a blank frame means the built-in one', async () => {
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          frameUrl: OWN_IMAGE,
        })
      ).fields,
    ).toEqual(['frameUrl']);
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          pictureUrl: OWN_FRAME,
        })
      ).fields,
    ).toEqual([]);
    const blank = await errorsOf(CreateLotteryDrawDto, {
      thaiDrawDate: '2026-11-01',
      frameUrl: '',
    });
    expect(blank.fields).toEqual([]);
    expect(blank.instance.frameUrl).toBeNull();
  });

  it('refuses a missing or impossible date, drawNo 0, a non-ISO close time, an off-site picture and an unknown field', async () => {
    expect((await errorsOf(CreateLotteryDrawDto, {})).fields).toEqual([
      'thaiDrawDate',
    ]);
    expect(
      (await errorsOf(CreateLotteryDrawDto, { thaiDrawDate: '2026-02-30' }))
        .fields,
    ).toEqual(['thaiDrawDate']);
    expect(
      (await errorsOf(CreateLotteryDrawDto, { thaiDrawDate: '1 Nov 2026' }))
        .fields,
    ).toEqual(['thaiDrawDate']);
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          drawNo: 0,
        })
      ).fields,
    ).toEqual(['drawNo']);
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          salesCloseAt: 'tomorrow',
        })
      ).fields,
    ).toEqual(['salesCloseAt']);
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          pictureUrl: 'https://evil.example/pixel.png',
        })
      ).fields,
    ).toEqual(['pictureUrl']);
    expect(
      (
        await errorsOf(CreateLotteryDrawDto, {
          thaiDrawDate: '2026-11-01',
          ticketPrice: 500,
        })
      ).fields,
    ).toEqual(['ticketPrice']);
  });
});

describe('UpdateLotteryDrawDto', () => {
  it('accepts an empty body with no defined field', async () => {
    const { instance, fields } = await errorsOf(UpdateLotteryDrawDto, {});
    expect(fields).toEqual([]);
    expect(Object.entries(instance).filter(([, v]) => v !== undefined)).toEqual(
      [],
    );
  });

  it('reads a blank picture or frame as "clear" and a blank date as "keep"', async () => {
    const { instance, fields } = await errorsOf(UpdateLotteryDrawDto, {
      pictureUrl: '',
      frameUrl: '',
      thaiDrawDate: '',
      ticketPrice: '2000',
      maxPerNumber: 5,
    });
    expect(fields).toEqual([]);
    expect(instance.pictureUrl).toBeNull();
    expect(instance.frameUrl).toBeNull();
    expect(instance.thaiDrawDate).toBeUndefined();
    expect(instance.ticketPrice).toBe(2000);
    expect(instance.maxPerNumber).toBe(5);
  });

  it('takes an own frame and refuses any other image as a frame', async () => {
    const { instance, fields } = await errorsOf(UpdateLotteryDrawDto, {
      frameUrl: OWN_FRAME,
    });
    expect(fields).toEqual([]);
    expect(instance.frameUrl).toBe(OWN_FRAME);
    for (const frameUrl of [OWN_IMAGE, 'https://evil.example/frame.png']) {
      expect(
        (await errorsOf(UpdateLotteryDrawDto, { frameUrl })).fields,
      ).toEqual(['frameUrl']);
    }
  });

  it('applies the settings limits to the draw-level copies', async () => {
    expect(
      (await errorsOf(UpdateLotteryDrawDto, { ticketPrice: 0 })).fields,
    ).toEqual(['ticketPrice']);
    expect(
      (await errorsOf(UpdateLotteryDrawDto, { maxPerNumber: 101 })).fields,
    ).toEqual(['maxPerNumber']);
    expect(
      (await errorsOf(UpdateLotteryDrawDto, { status: 'open' })).fields,
    ).toEqual(['status']);
  });
});

describe('the admin list queries', () => {
  it('filters by a wire status and pages up to 100 draws', async () => {
    const { instance, fields } = await errorsOf(AdminDrawQueryDto, {
      status: 'open',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({ status: 'open', page: 1, pageSize: 20 });
    expect(
      (await errorsOf(AdminDrawQueryDto, { status: 'OPEN' })).fields,
    ).toEqual(['status']);
    expect(
      (await errorsOf(AdminDrawQueryDto, { pageSize: 101 })).fields,
    ).toEqual(['pageSize']);
  });

  it('pages the ticket list up to 200 and blanks an empty search', async () => {
    const { instance, fields } = await errorsOf(AdminDrawTicketsQueryDto, {
      q: '  ',
      pageSize: '200',
    });
    expect(fields).toEqual([]);
    expect(instance.q).toBeNull();
    expect(instance.pageSize).toBe(200);
    expect(
      (await errorsOf(AdminDrawTicketsQueryDto, { pageSize: 201 })).fields,
    ).toEqual(['pageSize']);
  });
});
