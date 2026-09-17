import { Prisma } from '../generated/prisma/client';
import {
  diffSnapshots,
  MAX_STRING_LENGTH,
  sanitizeSnapshot,
  sanitizeValue,
  stableStringify,
} from './audit-snapshot';

describe('sanitizeSnapshot', () => {
  it('returns null for null/undefined input', () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot(undefined)).toBeNull();
  });

  it('redacts secret-shaped keys at any depth, case-insensitively', () => {
    expect(
      sanitizeSnapshot({
        username: 'boss',
        password: 'hunter2',
        PasswordHash: 'x',
        refreshToken: 'y',
        otpCode: '123456',
        apiSecret: 'z',
        accessToken: 'w',
        nested: { token: 'deep', keep: 1 },
      }),
    ).toEqual({
      username: 'boss',
      password: '[redacted]',
      PasswordHash: '[redacted]',
      refreshToken: '[redacted]',
      otpCode: '[redacted]',
      apiSecret: '[redacted]',
      accessToken: '[redacted]',
      nested: { token: '[redacted]', keep: 1 },
    });
  });

  it('converts Decimal → number, Date → ISO string, BigInt → number', () => {
    expect(
      sanitizeSnapshot({
        amount: new Prisma.Decimal('1234.50'),
        at: new Date('2026-09-09T12:00:00.000Z'),
        size: BigInt(42),
      }),
    ).toEqual({ amount: 1234.5, at: '2026-09-09T12:00:00.000Z', size: 42 });
  });

  it('truncates strings longer than the cap to a marker with a preview', () => {
    const long = 'a'.repeat(MAX_STRING_LENGTH + 1);
    expect(sanitizeSnapshot({ description: long })).toEqual({
      description: {
        _truncated: true,
        length: MAX_STRING_LENGTH + 1,
        preview: 'a'.repeat(200),
      },
    });
    const exact = 'b'.repeat(MAX_STRING_LENGTH);
    expect(sanitizeSnapshot({ description: exact })).toEqual({
      description: exact,
    });
  });

  it('flattens objects nested deeper than four levels to a capped JSON string', () => {
    // depth 1: a, depth 2: b, depth 3: c, depth 4: d, depth 5: e (too deep)
    const snapshot = sanitizeSnapshot({
      a: { b: { c: { d: { e: { f: 'deep', password: 'x' } } } } },
    });
    const d = (snapshot as any).a.b.c.d;
    expect(typeof d.e).toBe('string');
    expect(JSON.parse(d.e)).toEqual({ f: 'deep', password: '[redacted]' });
  });

  it('drops undefined and function values, keeps null/false/0', () => {
    expect(
      sanitizeSnapshot({
        gone: undefined,
        fn: () => 1,
        nothing: null,
        no: false,
        zero: 0,
      }),
    ).toEqual({ nothing: null, no: false, zero: 0 });
  });

  it('does not mutate the input', () => {
    const input = { password: 'x', list: [{ token: 'y' }] };
    sanitizeSnapshot(input);
    expect(input).toEqual({ password: 'x', list: [{ token: 'y' }] });
  });

  it('sanitizeValue handles arrays and non-finite numbers', () => {
    expect(sanitizeValue([1, NaN, 'x', { secret: 's' }])).toEqual([
      1,
      null,
      'x',
      { secret: '[redacted]' },
    ]);
  });
});

describe('stableStringify', () => {
  it('ignores key order and coerces Decimal/Date like sanitizeSnapshot', () => {
    expect(stableStringify({ b: new Prisma.Decimal('2'), a: 1 })).toBe(
      stableStringify({ a: 1, b: 2 }),
    );
    expect(stableStringify(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '"2026-01-01T00:00:00.000Z"',
    );
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('diffSnapshots', () => {
  it('returns only the fields whose value differs', () => {
    expect(
      diffSnapshots(
        { title: 'Old', status: 'DRAFT', year: 2020 },
        { title: 'New', status: 'DRAFT', year: 2020 },
      ),
    ).toEqual([{ field: 'title', from: 'Old', to: 'New' }]);
  });

  it('is empty for identical snapshots, whatever the key order', () => {
    expect(
      diffSnapshots({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 }),
    ).toEqual([]);
  });

  it('treats a missing key and null as the same value', () => {
    expect(diffSnapshots({ director: null }, {})).toEqual([]);
    expect(diffSnapshots({}, { director: null })).toEqual([]);
  });

  it('reports keys only one side has, in before-then-after order', () => {
    expect(diffSnapshots({ a: 1, gone: 'x' }, { a: 1, added: 'y' })).toEqual([
      { field: 'gone', from: 'x', to: null },
      { field: 'added', from: null, to: 'y' },
    ]);
  });

  it('compares dates and Decimals by value, not by representation', () => {
    expect(
      diffSnapshots(
        {
          amount: new Prisma.Decimal('10.00'),
          at: new Date('2026-01-01T00:00:00.000Z'),
        },
        { amount: 10, at: '2026-01-01T00:00:00.000Z' },
      ),
    ).toEqual([]);
    expect(
      diffSnapshots(
        { amount: new Prisma.Decimal('10.00') },
        { amount: new Prisma.Decimal('12.50') },
      ),
    ).toEqual([
      {
        field: 'amount',
        from: new Prisma.Decimal('10.00'),
        to: new Prisma.Decimal('12.50'),
      },
    ]);
  });

  it('compares relation lists as sets by id, ignoring order', () => {
    expect(
      diffSnapshots(
        {
          categories: [
            { id: 'c2', name: 'Drama' },
            { id: 'c1', name: 'Action' },
          ],
        },
        {
          categories: [
            { id: 'c1', name: 'Action' },
            { id: 'c2', name: 'Drama' },
          ],
        },
      ),
    ).toEqual([]);
  });

  it('emits the name lists when a relation set changes', () => {
    expect(
      diffSnapshots(
        {
          categories: [
            { id: 'c1', name: 'Action' },
            { id: 'c2', name: 'Drama' },
          ],
        },
        { categories: [{ id: 'c1', name: 'Action' }] },
      ),
    ).toEqual([
      { field: 'categories', from: ['Action', 'Drama'], to: ['Action'] },
    ]);
  });

  it('a relation entry renamed but with the same id is not a set change', () => {
    expect(
      diffSnapshots(
        { actors: [{ id: 'a1', name: 'Old Name' }] },
        { actors: [{ id: 'a1', name: 'New Name' }] },
      ),
    ).toEqual([]);
  });

  it('plain string arrays (permissions) compare by content', () => {
    expect(
      diffSnapshots(
        { permissions: ['MOVIES.VIEW', 'MOVIES.EDIT'] },
        { permissions: ['MOVIES.VIEW'] },
      ),
    ).toEqual([
      {
        field: 'permissions',
        from: ['MOVIES.VIEW', 'MOVIES.EDIT'],
        to: ['MOVIES.VIEW'],
      },
    ]);
  });

  it('accepts null on either side', () => {
    expect(diffSnapshots(null, { a: 1 })).toEqual([
      { field: 'a', from: null, to: 1 },
    ]);
    expect(diffSnapshots({ a: 1 }, undefined)).toEqual([
      { field: 'a', from: 1, to: null },
    ]);
  });
});
