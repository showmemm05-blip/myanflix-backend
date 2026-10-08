import { SmsJobWaiter } from './sms-job-waiter';

const DEVICE = 'device-a';

describe('SmsJobWaiter', () => {
  let waiter: SmsJobWaiter;

  beforeEach(() => {
    jest.useFakeTimers();
    waiter = new SmsJobWaiter();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('wakes a waiting poll the moment a job is queued', async () => {
    const ticket = waiter.begin(DEVICE);
    const woken = waiter.wait(DEVICE, ticket, waiter.generation, 25_000);

    waiter.notifyJobQueued();

    await expect(woken).resolves.toBe('job');
  });

  it('never misses a job queued between the empty lease and the wait', async () => {
    const ticket = waiter.begin(DEVICE);
    const seen = waiter.generation; // read before the (empty) lease
    waiter.notifyJobQueued(); // lands while the lease query runs

    await expect(waiter.wait(DEVICE, ticket, seen, 25_000)).resolves.toBe(
      'job',
    );
  });

  it('times out when nothing is queued', async () => {
    const ticket = waiter.begin(DEVICE);
    const woken = waiter.wait(DEVICE, ticket, waiter.generation, 5_000);

    jest.advanceTimersByTime(5_000);

    await expect(woken).resolves.toBe('timeout');
  });

  it('a newer poll from the same device releases the older one', async () => {
    const stale = waiter.begin(DEVICE);
    const staleWait = waiter.wait(DEVICE, stale, waiter.generation, 25_000);

    const fresh = waiter.begin(DEVICE);

    await expect(staleWait).resolves.toBe('superseded');
    expect(waiter.isCurrent(DEVICE, stale)).toBe(false);
    expect(waiter.isCurrent(DEVICE, fresh)).toBe(true);
    await expect(
      waiter.wait(DEVICE, stale, waiter.generation, 25_000),
    ).resolves.toBe('superseded');
  });

  it("another device's poll does not release this one", async () => {
    const ticket = waiter.begin(DEVICE);
    const woken = waiter.wait(DEVICE, ticket, waiter.generation, 1_000);

    waiter.begin('device-b');
    jest.advanceTimersByTime(1_000);

    await expect(woken).resolves.toBe('timeout');
  });

  it('stops at once when the client goes away', async () => {
    const ticket = waiter.begin(DEVICE);
    const gone = new AbortController();
    const woken = waiter.wait(
      DEVICE,
      ticket,
      waiter.generation,
      25_000,
      gone.signal,
    );

    gone.abort();

    await expect(woken).resolves.toBe('aborted');
    await expect(
      waiter.wait(DEVICE, ticket, waiter.generation, 25_000, gone.signal),
    ).resolves.toBe('aborted');
  });

  it('releases every waiter on shutdown', async () => {
    const ticket = waiter.begin(DEVICE);
    const woken = waiter.wait(DEVICE, ticket, waiter.generation, 25_000);

    waiter.onModuleDestroy();

    await expect(woken).resolves.toBe('aborted');
  });

  it('end() forgets only its own ticket', () => {
    const old = waiter.begin(DEVICE);
    const current = waiter.begin(DEVICE);

    waiter.end(DEVICE, old);
    expect(waiter.isCurrent(DEVICE, current)).toBe(true);

    waiter.end(DEVICE, current);
    expect(waiter.isCurrent(DEVICE, current)).toBe(false);
  });
});
