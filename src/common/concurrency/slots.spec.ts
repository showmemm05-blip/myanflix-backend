import { ConversionSlots, videoTranscodeConcurrency } from './slots';

describe('ConversionSlots', () => {
  it('hands out `limit` slots at once and queues the rest in FIFO order', async () => {
    const slots = new ConversionSlots(() => 1);
    await slots.acquire();
    const order: string[] = [];
    const second = slots.acquire().then(() => order.push('second'));
    const third = slots.acquire().then(() => order.push('third'));
    await new Promise((r) => setImmediate(r));
    expect(slots.active).toBe(1);
    expect(slots.queued).toBe(2);

    slots.release();
    await second;
    slots.release();
    await third;
    expect(order).toEqual(['second', 'third']);
    slots.release();
    expect(slots.active).toBe(0);
    expect(slots.queued).toBe(0);
  });

  it('hands a released slot straight to the waiter, so a new acquire() in between cannot slip past the limit', async () => {
    const slots = new ConversionSlots(() => 1);
    await slots.acquire();
    let waiterRunning = false;
    const waiter = slots.acquire().then(() => {
      waiterRunning = true;
    });
    await new Promise((r) => setImmediate(r));

    slots.release();
    // Same tick as the release, before the waiter's continuation has run.
    let latecomerRunning = false;
    const latecomer = slots.acquire().then(() => {
      latecomerRunning = true;
    });
    expect(slots.active).toBe(1);

    await waiter;
    await new Promise((r) => setImmediate(r));
    expect(waiterRunning).toBe(true);
    expect(latecomerRunning).toBe(false);
    expect(slots.active).toBe(1);
    expect(slots.queued).toBe(1);

    slots.release();
    await latecomer;
    expect(latecomerRunning).toBe(true);
    slots.release();
    expect(slots.active).toBe(0);
  });

  it('never goes below zero on an extra release', () => {
    const slots = new ConversionSlots(() => 1);
    slots.release();
    expect(slots.active).toBe(0);
  });
});

describe('videoTranscodeConcurrency', () => {
  const saved = process.env.VIDEO_TRANSCODE_CONCURRENCY;
  afterEach(() => {
    if (saved === undefined) delete process.env.VIDEO_TRANSCODE_CONCURRENCY;
    else process.env.VIDEO_TRANSCODE_CONCURRENCY = saved;
  });

  it.each([
    [undefined, 1],
    ['', 1],
    ['abc', 1],
    ['1.5', 1],
    ['0', 1],
    ['-3', 1],
    ['1', 1],
    ['2', 2],
    ['8', 8],
    ['50', 8],
  ])('VIDEO_TRANSCODE_CONCURRENCY=%p -> %p', (value, expected) => {
    if (value === undefined) delete process.env.VIDEO_TRANSCODE_CONCURRENCY;
    else process.env.VIDEO_TRANSCODE_CONCURRENCY = value;
    expect(videoTranscodeConcurrency()).toBe(expected);
  });
});
