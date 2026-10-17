import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = makeRoot('provenance-cli', { init: false });
  hippoDir = path.join(tmpDir, '.hippo');
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

// In process, so coverage sees the verb; the shape matches the spawned run it replaced.
async function runHippo(args: string[]): Promise<RunResult> {
  const r = await runCliAs(args, { env: { ...process.env, HIPPO_HOME: path.join(tmpDir, 'global') }, cwd: tmpDir });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

describe('hippo provenance CLI', () => {
  it('reports the trivially-satisfied gate when no raw rows exist', async () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('legacy distilled memory predating envelope', { kind: 'distilled' }),
    );

    const r = await runHippo(['provenance', '--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No kind=raw memories present');
  });

  it('emits machine-readable coverage with --json including gap detail', async () => {
    initStore(hippoDir);

    writeEntry(
      hippoDir,
      createMemory('slack message ingested with full envelope', {
        kind: 'raw',
        owner: 'user:keith',
        artifactRef: 'slack://team/eng/1714600000.001',
      }),
    );
    writeEntry(
      hippoDir,
      createMemory('raw row from a misconfigured connector', {
        kind: 'raw',
        owner: null,
        artifactRef: null,
      }),
    );

    const r = await runHippo(['provenance', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.rawTotal).toBe(2);
    expect(parsed.rawWithEnvelope).toBe(1);
    expect(parsed.coverage).toBeCloseTo(0.5, 5);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0].missing.sort()).toEqual(['artifact_ref', 'owner']);
  });

  it('exits non-zero under --strict when raw coverage drops below 100%', async () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('raw row missing envelope', { kind: 'raw' }),
    );

    const r = await runHippo(['provenance', '--strict']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Provenance coverage');
    expect(r.stdout).toContain('missing');
  });

  it('exits zero under --strict when every raw receipt is envelope-complete', async () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('raw row with full envelope', {
        kind: 'raw',
        owner: 'agent:hippo',
        artifactRef: 'gh://hippo/hippo-memory/pull/100',
      }),
    );

    const r = await runHippo(['provenance', '--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1/1 raw rows envelope-complete (100.0%)');
  });
});
