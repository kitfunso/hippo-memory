// A hook whose delivery recorder cannot start skips the ledger with one leveled warn line and still returns null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeliveryRecorder } from '../src/cli/hook-runtime.js';

describe('startDeliveryRecorder when the recorder cannot start', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null and writes one warn line with a space after the colon', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A number where a root path belongs: path.join throws on it, which is the start-up failure under test.
    const badRoot: string = JSON.parse('42');
    expect(startDeliveryRecorder(badRoot, undefined, 'claude-code')).toBeNull();
    expect(err.mock.calls).toHaveLength(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] warn: delivery ledger skipped: \S.* ts=\S+\n$/);
  });
});
