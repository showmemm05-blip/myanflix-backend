/**
 * A counting semaphore with a FIFO queue — the smallest thing that bounds
 * how many heavy pipelines (book page conversion, video transcodes) run at
 * once in this process. `acquire()` resolves immediately while a slot is
 * free, otherwise when an earlier holder releases.
 *
 * The limit is read through a function on every acquire, so a spec (or an
 * env change picked up by the function) needs no new instance.
 */
export class ConversionSlots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<void> {
    if (this.running < this.limit()) {
      this.running++;
      return;
    }
    // Woken by release(), which hands its slot straight over: `running`
    // already counts this caller, so it must not be raised again here.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the slot directly to the next waiter without ever lowering the
      // count. Lowering it first would leave a gap (until the waiter's
      // microtask runs) in which a brand-new acquire() sees a free slot and
      // runs alongside the waiter — two at once with a limit of 1.
      next();
      return;
    }
    this.running = Math.max(0, this.running - 1);
  }
}

/** Highest VIDEO_TRANSCODE_CONCURRENCY honoured: each ffmpeg already uses up to 6 threads. */
export const MAX_VIDEO_TRANSCODE_CONCURRENCY = 8;

/**
 * How many video transcode pipelines may run at the same time across the
 * whole process. Every pipeline is a multi-threaded ffmpeg plus a multi-GB
 * storage upload on the box that also runs the API and Postgres, so the
 * default is one at a time; extra videos wait (still PROCESSING) for their
 * turn. VIDEO_TRANSCODE_CONCURRENCY overrides it. On a running backend the
 * value is already checked at start-up (config/env.validation.ts refuses to
 * start unless it is unset/empty or a whole number 1-8), so the clamp to 1-8
 * and the fallback to 1 for anything else below are only a second guard for
 * code paths that skip that check (specs, scripts).
 */
export function videoTranscodeConcurrency(): number {
  const raw = Number(process.env.VIDEO_TRANSCODE_CONCURRENCY);
  if (!Number.isInteger(raw)) return 1;
  return Math.min(MAX_VIDEO_TRANSCODE_CONCURRENCY, Math.max(1, raw));
}
