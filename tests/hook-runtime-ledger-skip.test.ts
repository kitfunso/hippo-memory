// A hook whose delivery recorder cannot start skips the ledger with one leveled warn line and still returns null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/config.js')>()),
  loadConfig: () => { throw new Error('config unreadable'); },
}));

import { initStore } from '../src/store/open.js';
import { startDeliveryRecorder } from '../src/cli/hook-runtime.js';

describe('startDeliveryRecorder when the recorder cannot start', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null and writes one warn line with a space after the colon', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-skip-'));
    try {
      initStore(root);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(startDeliveryRecorder(root, undefined, 'claude-code')).toBeNull();
      expect(err.mock.calls).toHaveLength(1);
      expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] warn: delivery ledger skipped: config unreadable ts=\S+\n$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
