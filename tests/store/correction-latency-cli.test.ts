import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { createMemory, MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

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
  entry.validFrom = iso;
  entry.lastRetrieved = iso;
  return entry;
}

describe('hippo correction-latency CLI', () => {
  it('reports the empty case when no supersessions exist', async () => {
    initTestStore(hippoDir);
    writeEntry(
      hippoDir,
      createMemory('a single belief, never corrected', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    );

    const r = await runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No supersessions found');
  });

  it('emits JSON percentiles for an extraction-driven correction', async () => {
    initTestStore(hippoDir);

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
    oldFact.supersededBy = newFact.id;

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
    initTestStore(hippoDir);

    const oldFact = withCreated(
      createMemory('belief: tier is 100', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      '2026-03-15T00:00:00.000Z',
    );
    const newFact = withCreated(
      createMemory('belief: tier is 120', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      '2026-04-01T10:30:00.000Z',
    );
    oldFact.supersededBy = newFact.id;

    writeEntry(hippoDir, oldFact);
    writeEntry(hippoDir, newFact);

    const r = await runHippo(['correction-latency']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 manual');
    expect(r.stdout).toContain('extracted_from');
  });
});
