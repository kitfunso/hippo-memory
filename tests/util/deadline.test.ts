// withDeadline: a callback that answers after its deadline is late, even when it blocks the thread.
import { describe, it, expect } from 'vitest';
import { DeadlineError, withDeadline } from '../../src/base/util/deadline.js';

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

describe('withDeadline', () => {
  it('rejects a synchronous callback that blocks past the deadline and aborts its signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(10, (signal) => {
        seen = signal;
        busyWait(60);
        return 'late';
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(DeadlineError);
  });

  it('rejects with DeadlineError, not the callback error, when a blocking callback throws late', async () => {
    await expect(
      withDeadline(10, () => {
        busyWait(60);
        throw new Error('plain');
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
  });

  it('rejects an async callback that waits past the deadline and aborts its signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(10, async (signal) => {
        seen = signal;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'late';
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(seen?.aborted).toBe(true);
  });

  it('returns the value of a callback that answers in time and leaves its signal alone', async () => {
    let seen: AbortSignal | undefined;
    const value = await withDeadline(1_000, (signal) => {
      seen = signal;
      return 'on time';
    });
    expect(value).toBe('on time');
    expect(seen?.aborted).toBe(false);
  });

  it('passes through the error of a callback that throws in time', async () => {
    const boom = new Error('boom');
    await expect(
      withDeadline(1_000, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('keeps an on-time answer when another call blocks the thread before it is read', async () => {
    const [fast, slow] = await Promise.allSettled([
      withDeadline(20, () => 'fast'),
      withDeadline(10, () => {
        busyWait(80);
        return 'slow';
      }),
    ]);
    expect(fast).toEqual({ status: 'fulfilled', value: 'fast' });
    expect(slow.status).toBe('rejected');
    expect(slow.status === 'rejected' && slow.reason).toBeInstanceOf(DeadlineError);
  });

  it('rejects an async callback that blocks the thread after an await and aborts its signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(10, async (signal) => {
        seen = signal;
        await Promise.resolve();
        busyWait(60);
        return 'late';
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(seen?.aborted).toBe(true);
  });
});
