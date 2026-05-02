import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, MemoryEntry } from '../src/memory.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-correction-cli-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

interface RunResult {
  stdout: string;
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
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

function withCreated<T extends MemoryEntry>(entry: T, iso: string): T {
  (entry as { created: string }).created = iso;
  (entry as { valid_from: string }).valid_from = iso;
  (entry as { last_retrieved: string }).last_retrieved = iso;
  return entry;
}

describe('hippo correction-latency CLI', () => {
  it('reports the empty case when no supersessions exist', () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('a single belief, never corrected', {}));

    const r = runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No supersessions found');
  });

  it('emits JSON percentiles for an extraction-driven correction', () => {
    initStore(hippoDir);

    const raw = withCreated(
      createMemory('slack: tier moved to 120', {
        kind: 'raw',
        owner: 'user:keith',
        artifact_ref: 'slack://team/eng/1714600200.001',
      }),
      '2026-04-01T10:00:00.000Z',
    );
    writeEntry(hippoDir, raw);

    const oldFact = withCreated(
      createMemory('belief: tier is 100', {}),
      '2026-03-15T00:00:00.000Z',
    );
    const newFact = withCreated(
      createMemory('belief: tier is 120', { extracted_from: raw.id }),
      '2026-04-01T10:30:00.000Z',
    );
    (oldFact as { superseded_by: string | null }).superseded_by = newFact.id;

    writeEntry(hippoDir, oldFact);
    writeEntry(hippoDir, newFact);

    const r = runHippo(['correction-latency', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.extractionCount).toBe(1);
    expect(parsed.manualCount).toBe(0);
    expect(parsed.p50Ms).toBe(30 * 60 * 1000);
    expect(parsed.maxMs).toBe(30 * 60 * 1000);
    expect(parsed.pairs).toHaveLength(1);
    expect(parsed.pairs[0].via).toBe('extraction');
  });

  it('flags manual-only stores and explains how to surface latency', () => {
    initStore(hippoDir);

    const oldFact = withCreated(
      createMemory('belief: tier is 100', {}),
      '2026-03-15T00:00:00.000Z',
    );
    const newFact = withCreated(
      createMemory('belief: tier is 120', {}),
      '2026-04-01T10:30:00.000Z',
    );
    (oldFact as { superseded_by: string | null }).superseded_by = newFact.id;

    writeEntry(hippoDir, oldFact);
    writeEntry(hippoDir, newFact);

    const r = runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 manual');
    expect(r.stdout).toContain('extracted_from');
  });
});
