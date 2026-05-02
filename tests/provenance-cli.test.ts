import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-provenance-cli-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runHippo(args: string[]): RunResult {
  const globalDir = path.join(tmpDir, 'global');
  try {
    const stdout = execFileSync(process.execPath, [HIPPO_JS, ...args], {
      env: { ...process.env, HIPPO_HOME: globalDir },
      cwd: tmpDir,
      encoding: 'utf8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

describe('hippo provenance CLI', () => {
  it('reports the trivially-satisfied gate when no raw rows exist', () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('legacy distilled memory predating envelope', { kind: 'distilled' }),
    );

    const r = runHippo(['provenance', '--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No kind=raw memories present');
  });

  it('emits machine-readable coverage with --json including gap detail', () => {
    initStore(hippoDir);

    writeEntry(
      hippoDir,
      createMemory('slack message ingested with full envelope', {
        kind: 'raw',
        owner: 'user:keith',
        artifact_ref: 'slack://team/eng/1714600000.001',
      }),
    );
    writeEntry(
      hippoDir,
      createMemory('raw row from a misconfigured connector', {
        kind: 'raw',
        owner: null,
        artifact_ref: null,
      }),
    );

    const r = runHippo(['provenance', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.rawTotal).toBe(2);
    expect(parsed.rawWithEnvelope).toBe(1);
    expect(parsed.coverage).toBeCloseTo(0.5, 5);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0].missing.sort()).toEqual(['artifact_ref', 'owner']);
  });

  it('exits non-zero under --strict when raw coverage drops below 100%', () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('raw row missing envelope', { kind: 'raw' }),
    );

    const r = runHippo(['provenance', '--strict']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Provenance coverage');
    expect(r.stdout).toContain('missing');
  });

  it('exits zero under --strict when every raw receipt is envelope-complete', () => {
    initStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('raw row with full envelope', {
        kind: 'raw',
        owner: 'agent:hippo',
        artifact_ref: 'gh://hippo/hippo-memory/pull/100',
      }),
    );

    const r = runHippo(['provenance', '--strict']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1/1 raw rows envelope-complete (100.0%)');
  });
});
