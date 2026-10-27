import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAfterWorkers } from './worker-pids.js';

describe('removeAfterWorkers', () => {
  it('names a worker count mismatch and still removes the folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-pids-'));
    writeFileSync(join(dir, 'spawns.jsonl'), '');
    await expect(removeAfterWorkers(dir, 1, 'the run')).rejects.toThrow(
      /the run: expected 1 session-end worker\(s\), the spawn record holds 0/,
    );
    expect(existsSync(dir)).toBe(false);
  });
});
