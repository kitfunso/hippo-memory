// Two first imports at once give one row: 4 child processes x 40 notes, sized as store-stats-concurrency.test.ts sizes its race.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { initStore } from '../src/store.js';
import {
  agentRows, assertFreshDist, closeWorld, codexSummary, distUrl, liveRows, note, openWorld, projectNotes, type World,
} from './_helpers/agent-memories-world.js';

const WORKERS = 4;
const NOTES = 40;
const WORKER = `
const [, , syncUrl, root, home, startAt] = process.argv;
const { importForStore } = await import(syncUrl);
await new Promise((done) => setTimeout(done, Math.max(0, Number(startAt) - Date.now())));
const report = importForStore(root, { machine: { home, env: {}, platform: process.platform } });
const imported = report.tools.reduce((n, t) => n + t.tally.imported, 0);
process.stdout.write(JSON.stringify({ imported, warnings: report.warnings }));
`;

interface WorkerOut {
  readonly imported: number;
  readonly warnings: string[];
}

interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let w: World;
beforeEach(() => {
  w = openWorld();
});
afterEach(() => closeWorld(w));

function runWorker(args: readonly string[]): Promise<Finished> {
  return new Promise((resolve, fail) => {
    const child = spawn(process.execPath, [join(w.dir, 'worker.mjs'), ...args], { env: { ...process.env, HIPPO_HOME: w.global }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', fail);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Every worker waits for one shared start time after loading, so the imports overlap. */
async function race(roots: readonly string[]): Promise<WorkerOut[]> {
  writeFileSync(join(w.dir, 'worker.mjs'), WORKER, 'utf8');
  const startAt = String(Date.now() + 2000);
  const done = await Promise.all(roots.map((root) => runWorker([distUrl('agent-memories/sync.js'), root, w.home, startAt])));
  for (const d of done) expect(d.code, d.stderr).toBe(0);
  // SAFETY: the worker prints one JSON object with these two fields.
  return done.map((d) => JSON.parse(d.stdout) as WorkerOut);
}

describe('agent memory sync: concurrent first imports', () => {
  it('four processes importing the same 40 notes into one fresh store give exactly one row per note', async () => {
    assertFreshDist('agent-memories/sync.js');
    for (let i = 0; i < NOTES; i++) note(projectNotes(w), `n${i}.md`, `Race note ${i}: build ${i + 100} needs the schema check first.`);

    const outs = await race(Array.from({ length: WORKERS }, () => w.local));
    expect(outs.reduce((n, o) => n + o.imported, 0)).toBe(NOTES);
    expect(agentRows(w.local)).toHaveLength(NOTES);
    expect(new Set(liveRows(w.local).map((e) => e.source)).size).toBe(NOTES);
  }, 120_000);

  it('four projects\' sleeps racing on the user pass give one global row per Codex bullet', async () => {
    assertFreshDist('agent-memories/sync.js');
    codexSummary(w, ...Array.from({ length: NOTES }, (_, i) => `- Preference ${i}: run check ${i + 100} before merging.`));
    const roots = Array.from({ length: WORKERS }, (_, i) => {
      const root = join(w.dir, `p${i}`, '.hippo');
      initStore(root);
      return root;
    });

    const outs = await race(roots);
    expect(outs.reduce((n, o) => n + o.imported, 0)).toBe(NOTES);
    expect(agentRows(w.global)).toHaveLength(NOTES);
    expect(new Set(liveRows(w.global).map((e) => e.source)).size).toBe(NOTES);
  }, 120_000);
});
