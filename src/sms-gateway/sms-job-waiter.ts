import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type WakeReason = 'job' | 'timeout' | 'aborted' | 'superseded';

const JOB_QUEUED = 'job-queued';
const POLL_STARTED = 'poll-started';
const SHUTDOWN = 'shutdown';

/**
 * In-process wake-up for the gateway phone's long-poll
 * (GET /sms-gateway/device/jobs). One backend process, one phone: an
 * EventEmitter is all the fan-out this needs — no Redis, no FCM.
 *
 *  - `notifyJobQueued()` wakes every waiting poll the moment SmsService
 *    queues a row; each re-tries the atomic lease, and SKIP LOCKED hands
 *    the row to exactly one of them.
 *  - A job queued between a poll's empty lease and its `wait()` is never
 *    missed: the poll passes the `generation` it saw BEFORE leasing, and a
 *    wait whose generation is already stale returns 'job' at once.
 *  - One live poll per device: `begin()` releases any older poll of the
 *    same device with 'superseded'. When the phone hops networks (Wi-Fi ->
 *    mobile data) its old connection can stay half-open on this side; were
 *    that stale poll still waiting, the next job could be leased into a
 *    socket nobody reads and be lost (at-most-once: it would end UNKNOWN).
 *  - On shutdown every waiter returns at once, so closing the app never
 *    hangs on a 25 s poll.
 */
@Injectable()
export class SmsJobWaiter implements OnModuleDestroy {
  private readonly emitter = new EventEmitter();
  private readonly currentPoll = new Map<string, number>();
  private pollSeq = 0;
  private jobGeneration = 0;

  constructor() {
    // One listener set per waiting poll; the count is bounded by the
    // per-device throttle, not by a fixed number.
    this.emitter.setMaxListeners(0);
  }

  /** Bumped by every queued job; see `wait`. */
  get generation(): number {
    return this.jobGeneration;
  }

  /** Starts a poll for `deviceId`, superseding that device's older poll. */
  begin(deviceId: string): number {
    const ticket = ++this.pollSeq;
    this.currentPoll.set(deviceId, ticket);
    this.emitter.emit(POLL_STARTED, deviceId, ticket);
    return ticket;
  }

  isCurrent(deviceId: string, ticket: number): boolean {
    return this.currentPoll.get(deviceId) === ticket;
  }

  end(deviceId: string, ticket: number): void {
    if (this.currentPoll.get(deviceId) === ticket) {
      this.currentPoll.delete(deviceId);
    }
  }

  notifyJobQueued(): void {
    this.jobGeneration += 1;
    this.emitter.emit(JOB_QUEUED);
  }

  /**
   * Resolves (never rejects) with why the poll should look again or stop:
   * 'job' (something was queued since `seenGeneration`), 'timeout',
   * 'aborted' (client gone or app shutting down) or 'superseded'.
   */
  wait(
    deviceId: string,
    ticket: number,
    seenGeneration: number,
    ms: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (!this.isCurrent(deviceId, ticket)) {
      return Promise.resolve('superseded');
    }
    if (this.jobGeneration !== seenGeneration) return Promise.resolve('job');
    if (ms <= 0) return Promise.resolve('timeout');

    return new Promise<WakeReason>((resolve) => {
      const onJob = () => finish('job');
      const onPoll = (id: string, newer: number) => {
        if (id === deviceId && newer !== ticket) finish('superseded');
      };
      const onAbort = () => finish('aborted');
      const timer = setTimeout(() => finish('timeout'), ms);
      const finish = (reason: WakeReason) => {
        clearTimeout(timer);
        this.emitter.off(JOB_QUEUED, onJob);
        this.emitter.off(POLL_STARTED, onPoll);
        this.emitter.off(SHUTDOWN, onAbort);
        signal?.removeEventListener('abort', onAbort);
        resolve(reason);
      };
      this.emitter.on(JOB_QUEUED, onJob);
      this.emitter.on(POLL_STARTED, onPoll);
      this.emitter.on(SHUTDOWN, onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  onModuleDestroy(): void {
    this.emitter.emit(SHUTDOWN);
  }
}
