// HIPPO_BUSY_WAIT_MS sets the lock wait of an open that names none, read once when the module loads.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function defaultWait(value: string | undefined): Promise<number> {
  vi.stubEnv('HIPPO_BUSY_WAIT_MS', value);
  vi.resetModules();
  const { DEFAULT_BUSY_WAIT_MS } = await import('../../src/db/busy.js');
  return DEFAULT_BUSY_WAIT_MS;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('HIPPO_BUSY_WAIT_MS', () => {
  it('is 5000 ms when unset', async () => {
    expect(await defaultWait(undefined)).toBe(5000);
  });

  it('takes a positive whole number of ms', async () => {
    expect(await defaultWait('250')).toBe(250);
  });

  it.each(['0', '-5', 'abc', '1.5', '15s'])('reads %s as unset, so the default applies', async (value) => {
    expect(await defaultWait(value)).toBe(5000);
  });
});
