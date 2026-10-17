import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = makeRoot('correction-cli', { init: false });
  hippoDir = path.join(tmpDir, '.hippo');
});

interface RunResult {
  stdout: string;
  status: number;
}

// In process, so coverage sees the verb; the shape matches the spawned run it replaced.
async function runHippo(args: string[]): Promise<RunResult> {
  const r = await runCliAs(args, { env: { ...process.env, HIPPO_HOME: path.join(tmpDir, 'global') }, cwd: tmpDir });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

function withCreated<T extends MemoryEntry>(entry: T, iso: string): T {
  entry.created = iso;
  entry.valid_from = iso;
  entry.last_retrieved = iso;
  return entry;
}

describe('hippo correction-latency CLI', () => {
  it('reports the empty case when no supersessions exist', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('a single belief, never corrected', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));

    const r = await runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No supersessions found');
  });

  it('emits JSON percentiles for an extraction-driven correction', async () => {
    initStore(hippoDir);

    const raw = withCreated(
      createMemory('slack: tier moved to 120', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        kind: 'raw',
        owner: 'user:keith',
        artifactRef: 'slack://team/eng/1714600200.001',
      }),
      '2026-04-01T10:00:00.000Z',
    );
    writeEntry(hippoDir, raw);

    const oldFact = withCreated(
      createMemory('belief: tier is 100', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      '2026-03-15T00:00:00.000Z',
    );
    const newFact = withCreated(
      createMemory('belief: tier is 120', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, extractedFrom: raw.id }),
      '2026-04-01T10:30:00.000Z',
    );
    oldFact.superseded_by = newFact.id;

    writeEntry(hippoDir, oldFact);
    writeEntry(hippoDir, newFact);

    const r = await runHippo(['correction-latency', '--json']);
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

  it('flags manual-only stores and explains how to surface latency', async () => {
    initStore(hippoDir);

    const oldFact = withCreated(
      createMemory('belief: tier is 100', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      '2026-03-15T00:00:00.000Z',
    );
    const newFact = withCreated(
      createMemory('belief: tier is 120', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      '2026-04-01T10:30:00.000Z',
    );
    oldFact.superseded_by = newFact.id;

    writeEntry(hippoDir, oldFact);
    writeEntry(hippoDir, newFact);

    const r = await runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 manual');
    expect(r.stdout).toContain('extracted_from');
  });
});
