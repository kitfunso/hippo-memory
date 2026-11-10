// Two real `hippo sleep` processes on one store, the model held at its first call: the second one is refused and the sources are
// extracted once, and a first sleep that dies leaves no claim behind. The held model call is the hold point, not a delay.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { HIPPO_BIN } from '../_helpers/hippo-bin.js';
import { waitFor } from '../_helpers/wait-for.js';

// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const PRELOAD = resolve(__dirname, '..', '_helpers', 'slow-model-preload.cjs').split('\\').join('/');
const DAY_MS = 86_400_000;
const REFUSAL =
  /A sleep is already running on this store \(since \d{4}-\d\d-\d\dT[\d:.]+Z\), so this one skipped consolidation\./;
const TOPICS = ['billing export', 'staging cluster', 'vpn gateway', 'search index'];

interface Run {
  readonly child: ChildProcess;
  readonly done: Promise<{ status: number | null; stdout: string }>;
}

const live: ChildProcess[] = [];
const holds: string[] = [];

afterEach(() => {
  for (const hold of holds.splice(0)) rmSync(hold, { force: true });
  for (const child of live.splice(0)) child.kill('SIGKILL');
});

/** A store whose sources are the episodic rows extraction offers to the model, one call each. */
function seededStore() {
  const { base, root } = makeStore('one-sleep');
  const now = Date.now();
  TOPICS.forEach((topic, k) => {
    writeEntry(root, {
      ...createMemory(
        `Alice reviewed the ${topic} on day ${k} and wrote down item number ${k * 7 + 3} for the follow up`,
        {
          baseHalfLifeDays: 7,
          tenantId: 'default',
        },
      ),
      id: `mem_one_sleep_${k}`,
      created: new Date(now - (3 + k) * DAY_MS).toISOString(),
      lastRetrieved: new Date(now - DAY_MS).toISOString(),
    });
  });
  const markers = join(base, 'model-markers');
  mkdirSync(markers);
  return { base, root, markers };
}

function holdModel(markers: string): void {
  const hold = join(markers, 'hold');
  writeFileSync(hold, '');
  holds.push(hold);
}

function releaseModel(markers: string): void {
  rmSync(join(markers, 'hold'), { force: true });
}

function startSleep(base: string, markers: string, extra: readonly string[] = []): Run {
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'sk-ant-fake-key-for-the-stub',
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
    SLOW_MODEL_DIR: markers,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${PRELOAD}"`,
  };
  const child = spawn(process.execPath, [HIPPO_BIN, 'sleep', '--no-learn', '--no-share', ...extra], {
    cwd: base,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.push(child);
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const done = new Promise<{ status: number | null; stdout: string }>((resolveDone) => {
    child.on('close', (status) => resolveDone({ status, stdout }));
  });
  return { child, done };
}

const enteredExtractions = (markers: string): number =>
  readdirSync(markers).filter((name) => name.startsWith('entered-') && name.endsWith('-extract')).length;

/** How many facts each extracted-from source carries. */
function factsPerSource(root: string): number[] {
  const db = openHippoDb(root);
  try {
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE extracted_from IS NOT NULL GROUP BY extracted_from')
      .all() as { n: number }[];
    return rows.map((row) => row.n);
  } finally {
    closeHippoDb(db);
  }
}

/** The first sleep, held inside its first model call. */
async function startHeldSleep(base: string, markers: string): Promise<Run> {
  holdModel(markers);
  const first = startSleep(base, markers);
  await waitFor(() => enteredExtractions(markers) > 0, {
    timeoutMs: 15_000,
    what: 'the first sleep reaching the model',
  });
  return first;
}

/** The second sleep's outcome, or 'running' when it was still going after the wait. */
async function refusedOutcome(second: Run): Promise<{ status: number | null; stdout: string } | 'running'> {
  const waited = new Promise<'running'>((resolveWait) => setTimeout(() => resolveWait('running'), 12_000));
  return Promise.race([second.done, waited]);
}

describe('one sleep per store', () => {
  it('refuses a second sleep while the first runs, so each source is extracted once', async () => {
    const { base, root, markers } = seededStore();
    const first = await startHeldSleep(base, markers);

    const logFile = join(base, 'second-sleep.log');
    const outcome = await refusedOutcome(startSleep(base, markers, ['--log-file', logFile]));

    expect(outcome).toMatchObject({ status: 0, stdout: expect.stringMatching(REFUSAL) });
    expect(first.child.exitCode).toBeNull();
    const logged = readFileSync(logFile, 'utf8');
    expect(logged).toMatch(REFUSAL);
    expect(logged).not.toContain('sleep complete');

    releaseModel(markers);
    expect((await first.done).status).toBe(0);
    expect(enteredExtractions(markers)).toBe(TOPICS.length);
    expect(factsPerSource(root)).toEqual(TOPICS.map(() => 1));
  }, 30_000);

  it('lets a sleep run once the sleep that held the claim was killed', async () => {
    const { base, root, markers } = seededStore();
    const first = await startHeldSleep(base, markers);

    expect(await refusedOutcome(startSleep(base, markers))).toMatchObject({
      status: 0,
      stdout: expect.stringMatching(REFUSAL),
    });

    first.child.kill('SIGKILL');
    await first.done;
    releaseModel(markers);
    const third = await startSleep(base, markers).done;

    expect(third.status).toBe(0);
    expect(third.stdout).not.toMatch(REFUSAL);
    expect(third.stdout).toContain('Results:');
    expect(factsPerSource(root)).toEqual(TOPICS.map(() => 1));
  }, 30_000);
});
