import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdminClaimsQueryDto,
  AdminClaimsSummaryQueryDto,
  CLAIMS_PAGE_SIZE_DEFAULT,
  CLAIMS_PAGE_SIZE_MAX,
  MyClaimsQueryDto,
  RejectClaimDto,
  RequestClaimDto,
} from './lottery-claim.dto';

/** The same options as the global ValidationPipe in app.module.ts. */
const TRANSFORM = { enableImplicitConversion: true } as const;

const DRAW_ID = '33333333-3333-4333-8333-333333333333';

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

describe('RequestClaimDto', () => {
  it('needs a positive integer draw number (a numeric string too) and nothing else', async () => {
    expect(await errorsOf(RequestClaimDto, { drawNo: 2 })).toMatchObject({
      fields: [],
      instance: { drawNo: 2 },
    });
    expect(
      (await errorsOf(RequestClaimDto, { drawNo: '24' })).instance,
    ).toEqual({ drawNo: 24 });
    for (const drawNo of [0, -1, 1.5, 'abc', undefined]) {
      expect((await errorsOf(RequestClaimDto, { drawNo })).fields).toEqual([
        'drawNo',
      ]);
    }
    expect(
      (await errorsOf(RequestClaimDto, { drawNo: 2, ticketNo: 'x' })).fields,
    ).toEqual(['ticketNo']);
  });
});

describe('MyClaimsQueryDto', () => {
  it('defaults to page 1 of 20 and caps the page size at 100', async () => {
    expect((await errorsOf(MyClaimsQueryDto, {})).instance).toEqual({
      page: 1,
      pageSize: 20,
    });
    expect(
      (await errorsOf(MyClaimsQueryDto, { page: '3', pageSize: '100' }))
        .instance,
    ).toEqual({ page: 3, pageSize: 100 });
    expect(
      (await errorsOf(MyClaimsQueryDto, { page: 0, pageSize: 101 })).fields,
    ).toEqual(['page', 'pageSize']);
  });
});

describe('AdminClaimsQueryDto', () => {
  it('defaults to the waiting tab, page 1 of 25, and accepts every tab', async () => {
    expect(CLAIMS_PAGE_SIZE_DEFAULT).toBe(25);
    expect(CLAIMS_PAGE_SIZE_MAX).toBe(100);
    expect((await errorsOf(AdminClaimsQueryDto, {})).instance).toEqual({
      status: 'requested',
      page: 1,
      pageSize: 25,
    });
    for (const status of [
      'requested',
      'paid',
      'rejected',
      'not_requested',
      'all',
    ]) {
      expect((await errorsOf(AdminClaimsQueryDto, { status })).fields).toEqual(
        [],
      );
    }
  });

  it('takes a draw uuid, a trimmed search of up to 100 characters, and the page', async () => {
    const { instance, fields } = await errorsOf(AdminClaimsQueryDto, {
      status: 'paid',
      drawId: DRAW_ID,
      q: '  mya ',
      page: '2',
      pageSize: '100',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      status: 'paid',
      drawId: DRAW_ID,
      q: 'mya',
      page: 2,
      pageSize: 100,
    });
    // A blank search reads as none.
    expect((await errorsOf(AdminClaimsQueryDto, { q: '   ' })).instance.q).toBe(
      null,
    );
  });

  it('refuses an unknown tab, a non-uuid draw, an oversized page or search, and an unknown field', async () => {
    expect(
      (await errorsOf(AdminClaimsQueryDto, { status: 'waiting' })).fields,
    ).toEqual(['status']);
    expect(
      (await errorsOf(AdminClaimsQueryDto, { drawId: 'draw-1' })).fields,
    ).toEqual(['drawId']);
    expect(
      (await errorsOf(AdminClaimsQueryDto, { pageSize: 101 })).fields,
    ).toEqual(['pageSize']);
    expect(
      (await errorsOf(AdminClaimsQueryDto, { q: 'x'.repeat(101) })).fields,
    ).toEqual(['q']);
    expect(
      (await errorsOf(AdminClaimsQueryDto, { userId: 'u' })).fields,
    ).toEqual(['userId']);
  });
});

describe('AdminClaimsSummaryQueryDto', () => {
  it('takes no draw or a draw uuid', async () => {
    expect((await errorsOf(AdminClaimsSummaryQueryDto, {})).fields).toEqual([]);
    expect(
      (await errorsOf(AdminClaimsSummaryQueryDto, { drawId: DRAW_ID })).fields,
    ).toEqual([]);
    expect(
      (await errorsOf(AdminClaimsSummaryQueryDto, { drawId: '24' })).fields,
    ).toEqual(['drawId']);
  });
});

describe('RejectClaimDto', () => {
  it('accepts each preset reason without a note, and a trimmed note with any of them', async () => {
    for (const reason of [
      'suspicious_account',
      'duplicate_request',
      'ticket_under_review',
    ]) {
      expect((await errorsOf(RejectClaimDto, { reason })).fields).toEqual([]);
      expect(
        (await errorsOf(RejectClaimDto, { reason, note: '' })).instance,
      ).toEqual({ reason, note: null });
    }
    const { instance, fields } = await errorsOf(RejectClaimDto, {
      reason: 'other',
      note: '  Ticket photo does not match the number  ',
    });
    expect(fields).toEqual([]);
    expect(instance).toEqual({
      reason: 'other',
      note: 'Ticket photo does not match the number',
    });
  });

  it('requires a note when the reason is "other" — absent or blank is refused', async () => {
    expect(
      (await errorsOf(RejectClaimDto, { reason: 'other' })).fields,
    ).toEqual(['note']);
    expect(
      (await errorsOf(RejectClaimDto, { reason: 'other', note: '   ' })).fields,
    ).toEqual(['note']);
    expect(
      (await errorsOf(RejectClaimDto, { reason: 'other', note: null })).fields,
    ).toEqual(['note']);
  });

  it('refuses an unknown or missing reason, a note over 300 characters, a non-string note, and an unknown field', async () => {
    expect((await errorsOf(RejectClaimDto, {})).fields).toEqual(['reason']);
    expect(
      (await errorsOf(RejectClaimDto, { reason: 'fraud' })).fields,
    ).toEqual(['reason']);
    expect(
      (
        await errorsOf(RejectClaimDto, {
          reason: 'other',
          note: 'x'.repeat(301),
        })
      ).fields,
    ).toEqual(['note']);
    expect(
      (await errorsOf(RejectClaimDto, { reason: 'other', note: 42 })).fields,
    ).toEqual(['note']);
    expect(
      (
        await errorsOf(RejectClaimDto, {
          reason: 'duplicate_request',
          refund: true,
        })
      ).fields,
    ).toEqual(['refund']);
  });
});
