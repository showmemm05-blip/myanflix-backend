import { TMDB_STATUS_TTL_MS, TmdbStatusService } from './tmdb-status.service';
import type { TmdbClient } from './tmdb.client';

describe('TmdbStatusService — is TMDB connected?', () => {
  let client: { isEnabled: boolean; checkConnection: jest.Mock };
  let service: TmdbStatusService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-06T10:00:00.000Z') });
    client = {
      isEnabled: true,
      checkConnection: jest.fn().mockResolvedValue({ ok: true, data: true }),
    };
    service = new TmdbStatusService(client as unknown as TmdbClient);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('without TMDB_API_KEY: off, and TMDB is never asked', async () => {
    client.isEnabled = false;

    await expect(service.get()).resolves.toEqual({
      configured: false,
      state: 'off',
      checkedAt: null,
    });
    await expect(service.get(true)).resolves.toEqual({
      configured: false,
      state: 'off',
      checkedAt: null,
    });
    expect(client.checkConnection).not.toHaveBeenCalled();
  });

  it('connected, with the time of the check', async () => {
    await expect(service.get()).resolves.toEqual({
      configured: true,
      state: 'connected',
      checkedAt: '2026-11-06T10:00:00.000Z',
    });
  });

  it.each([
    ['key_rejected', 'key_rejected'],
    ['rate_limited', 'rate_limited'],
    ['unreachable', 'unreachable'],
    ['bad_response', 'unreachable'],
    ['not_found', 'unreachable'],
    ['not_configured', 'off'],
  ])('TMDB answers %s -> state %s', async (reason, state) => {
    client.checkConnection.mockResolvedValue({ ok: false, reason });

    await expect(service.get()).resolves.toEqual({
      configured: true,
      state,
      checkedAt: '2026-11-06T10:00:00.000Z',
    });
  });

  it('never carries the key, or anything but the three fields', async () => {
    const status = await service.get();

    expect(Object.keys(status).sort()).toEqual([
      'checkedAt',
      'configured',
      'state',
    ]);
  });

  it('reuses one check for a minute, then asks again', async () => {
    const first = await service.get();
    jest.setSystemTime(Date.now() + TMDB_STATUS_TTL_MS - 1);
    await expect(service.get()).resolves.toBe(first);
    expect(client.checkConnection).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 2);
    const later = await service.get();

    expect(client.checkConnection).toHaveBeenCalledTimes(2);
    expect(later.checkedAt).not.toBe(first.checkedAt);
  });

  it('a failure is remembered for the minute too — a page of staff is not a page of calls', async () => {
    client.checkConnection.mockResolvedValue({
      ok: false,
      reason: 'unreachable',
    });

    await service.get();
    await service.get();
    await service.get();

    expect(client.checkConnection).toHaveBeenCalledTimes(1);
  });

  it('"Check again" (fresh) skips the memory and replaces it', async () => {
    await service.get();
    client.checkConnection.mockResolvedValue({
      ok: false,
      reason: 'key_rejected',
    });

    await expect(service.get(true)).resolves.toEqual(
      expect.objectContaining({ state: 'key_rejected' }),
    );
    expect(client.checkConnection).toHaveBeenCalledTimes(2);
    // The next ordinary read sees the fresh answer without asking again.
    await expect(service.get()).resolves.toEqual(
      expect.objectContaining({ state: 'key_rejected' }),
    );
    expect(client.checkConnection).toHaveBeenCalledTimes(2);
  });

  it('callers that arrive while a check is running share it', async () => {
    let answer: (value: unknown) => void = () => undefined;
    client.checkConnection.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const callers = [service.get(), service.get(true), service.get()];
    answer({ ok: true, data: true });
    const statuses = await Promise.all(callers);

    expect(client.checkConnection).toHaveBeenCalledTimes(1);
    expect(statuses.map((status) => status.state)).toEqual([
      'connected',
      'connected',
      'connected',
    ]);
  });

  it('switching the key off takes effect at once, whatever was remembered', async () => {
    await service.get();
    client.isEnabled = false;

    await expect(service.get()).resolves.toEqual({
      configured: false,
      state: 'off',
      checkedAt: null,
    });
  });
});
