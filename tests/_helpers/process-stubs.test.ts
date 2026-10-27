import { describe, expect, it, vi } from 'vitest';
import { callMatching } from './process-stubs.js';

describe('callMatching', () => {
  it('resolves on a call made before the wait began', async () => {
    const spy = vi.fn();
    spy(1);
    spy(2);
    await expect(callMatching(spy, (n) => n === 2, { what: 'two' })).resolves.toEqual([2]);
  });

  it('resolves on a later call whose arguments pass, not on one that fails', async () => {
    const spy = vi.fn();
    const waited = callMatching(spy, (n) => n === 0, { what: 'exit 0' });
    spy(1);
    setTimeout(() => spy(0), 20);
    await expect(waited).resolves.toEqual([0]);
  });

  it('rejects at its deadline, naming what never came', async () => {
    const spy = vi.fn();
    spy(1);
    await expect(callMatching(spy, (n) => n === 0, { what: 'exit 0', deadlineMs: 50 })).rejects.toThrow(
      /exit 0 not called within 50 ms/,
    );
  });
});
