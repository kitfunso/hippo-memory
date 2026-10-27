import { describe, expect, it } from 'vitest';
import { defaultBusyWaitMs } from '../../src/db/busy.js';
import { runCliAs } from './run-cli-as.js';

describe('runCliAs', () => {
  it('leaves this process the lock wait it had: the run sets it as its root, as a spawned hippo would', async () => {
    const before = defaultBusyWaitMs();
    const r = await runCliAs(['--version'], { env: { ...process.env, HIPPO_BUSY_WAIT_MS: '300' } });
    expect(r.status).toBe(0);
    expect(defaultBusyWaitMs()).toBe(before);
  });
});
