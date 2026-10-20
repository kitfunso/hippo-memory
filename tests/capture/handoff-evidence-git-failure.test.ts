// A cwd outside any repository reads as unknown quietly; a git that cannot run is logged once, still as unknown.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { collectHandoffEvidence } from '../../src/surface/capture/handoff-evidence.js';

// Far past a loaded box's slow git start, so only a real failure reaches the log.
const GIT_WAIT_MS = 30_000;

let dir: string;
let stderr: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-handoff-'));
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const written = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');

describe('collectHandoffEvidence git failures', () => {
  it('stays quiet for a folder that is not a repository', () => {
    expect(collectHandoffEvidence(dir, 'unknown', { timeoutMs: GIT_WAIT_MS })).toEqual({
      gitRef: null,
      dirtyTree: null,
      testStatus: 'unknown',
    });
    expect(written()).toBe('');
  });

  it('warns once, with the error code, when git cannot be run at all', () => {
    vi.stubEnv('PATH', dir);
    expect(collectHandoffEvidence(dir, 'unknown', { timeoutMs: GIT_WAIT_MS })).toEqual({
      gitRef: null,
      dirtyTree: null,
      testStatus: 'unknown',
    });
    collectHandoffEvidence(dir, 'unknown', { timeoutMs: GIT_WAIT_MS });
    const lines = written()
      .split('\n')
      .filter((l) => l.includes('failed'));
    expect(lines.filter((l) => l.includes('git rev-parse HEAD failed (ENOENT)'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('git status --porcelain failed (ENOENT)'))).toHaveLength(1);
  });
});
