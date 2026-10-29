// The keeper of work a call starts and does not wait on: what it logs, what settle() waits for, and withDetached's
// choice between the root's keeper and a keeper of the call's own.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetachedSet } from '../../src/base/util/detached-set.js';
import { withDetached } from '../../src/api/detached.js';
import { log } from '../../src/base/util/log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A promise and the function that resolves it, so a test decides when the work ends. */
interface Held {
  readonly work: Promise<void>;
  readonly end: () => void;
}

function held(): Held {
  let end = (): void => undefined;
  const work = new Promise<void>((resolve) => {
    end = resolve;
  });
  return { work, end };
}

describe('DetachedSet', () => {
  it('logs a rejection nothing caught, with its error fields, and still settles', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const kept = new DetachedSet();
      kept.detach(Promise.reject(new TypeError('the embed endpoint refused')));
      expect(await kept.settle()).toBe(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(error).toHaveBeenCalledWith(
        'detached work failed: the embed endpoint refused',
        expect.objectContaining({ errorClass: 'TypeError', stack: expect.stringContaining('TypeError') }),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('settle() also waits for work detached while it waits', async () => {
    const kept = new DetachedSet();
    const first = held();
    const second = held();
    let settled = false;
    kept.detach(first.work.then(() => kept.detach(second.work)));
    const settling = kept.settle().then(() => {
      settled = true;
    });
    first.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    second.end();
    await settling;
    expect(settled).toBe(true);
  });

  it('settle(withinMs) resolves at the bound with how many still run, and with 0 once all have settled', async () => {
    const kept = new DetachedSet();
    const running = held();
    kept.detach(running.work);
    kept.detach(Promise.resolve());
    expect(await kept.settle(20)).toBe(1);
    running.end();
    expect(await kept.settle(20)).toBe(0);
  });
});

describe('withDetached', () => {
  it('with no keeper on the Context, resolves only after the work the call detached', async () => {
    const running = held();
    let returned = false;
    const call = withDetached({}, (detached) => {
      detached.detach(running.work);
      return 'answer';
    }).then((value) => {
      returned = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    running.end();
    expect(await call).toBe('answer');
  });

  it("hands the work to the Context's keeper and returns without waiting for it", async () => {
    const keeper = new DetachedSet();
    const running = held();
    expect(await withDetached({ detached: keeper }, (detached) => detached.detach(running.work))).toBeUndefined();
    expect(await keeper.settle(0)).toBe(1);
    running.end();
    expect(await keeper.settle()).toBe(0);
  });
});
