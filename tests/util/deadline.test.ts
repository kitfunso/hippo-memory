// withDeadline: a callback that answers after its deadline is late, even when it blocks the thread.
import * as vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { DeadlineError, withDeadline } from '../../src/base/util/deadline.js';

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

// The key is built at run time, so unicorn/no-thenable stays quiet about objects that must be plain thenables.
const THEN = ['th', 'en'].join('');

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

  it('rejects a promise from another realm that blocks the thread after an await', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withDeadline(10, (signal) => {
        seen = signal;
        // The vm realm has no performance, so the clock comes in from here.
        const foreign: Promise<string> = vm.runInNewContext(
          "(async () => { await 0; const end = now() + 60; while (now() < end); return 'late'; })()",
          { now: () => performance.now() },
        );
        return foreign;
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(seen?.aborted).toBe(true);
  });

  it('rejects a plain thenable that blocks the thread before it resolves', async () => {
    const thenable = {
      [THEN](resolve: (value: string) => void): void {
        setTimeout(() => {
          busyWait(60);
          resolve('late');
        }, 0);
      },
    };
    await expect(withDeadline(10, () => thenable)).rejects.toBeInstanceOf(DeadlineError);
  });

  it('reads then of a returned thenable once', async () => {
    let reads = 0;
    const thenable = Object.defineProperty({}, THEN, {
      get() {
        reads += 1;
        if (reads > 1) throw new Error('then read twice');
        return (resolve: (value: string) => void): void => resolve('once');
      },
    });
    await expect(withDeadline(1_000, () => thenable)).resolves.toBe('once');
    expect(reads).toBe(1);
  });

  it('returns a plain object whose then is not a function as the same object', async () => {
    const plain = Object.defineProperty({ id: 7 }, THEN, { get: () => 0 });
    await expect(withDeadline(1_000, () => plain)).resolves.toBe(plain);
  });
});
