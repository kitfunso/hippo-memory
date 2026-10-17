// Two first imports at once give one row: 4 child processes x 40 notes, sized as store-stats-concurrency.test.ts sizes its race.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { initStore } from '../src/store/open.js';
import {
  agentRows, closeWorld, codexSummary, distUrl, liveRows, note, openWorld, projectNotes, type World,
} from './_helpers/agent-memories-world.js';

const WORKERS = 4;
const NOTES = 40;
// Each worker signals it is loaded, then blocks until all have, so a run that serialised the workers would time out here.
const WORKER = `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , syncUrl, root, home, barrier, index, total] = process.argv;
const { importForStore } = await import(syncUrl);
const { loadConfig } = await import(new URL('../core/config.js', syncUrl).href);
const { sqliteAgentImport } = await import(new URL('../store/sqlite/agent-import.js', syncUrl).href);
mkdirSync(barrier, { recursive: true });
const arrivedAt = Date.now();
writeFileSync(join(barrier, 'ready-' + index), '');
const pause = new Int32Array(new SharedArrayBuffer(4));
const everyoneHere = () => Array.from({ length: Number(total) }, (_, i) => existsSync(join(barrier, 'ready-' + i))).every(Boolean);
while (!everyoneHere()) {
  if (Date.now() - arrivedAt > 20000) throw new Error('barrier timed out: the other workers never started');
  Atomics.wait(pause, 0, 0, 2);
}
const report = importForStore(root, { configAt: loadConfig, agentImport: sqliteAgentImport, machine: { home, env: {}, platform: process.platform } });
const imported = report.tools.reduce((n, t) => n + t.tally.imported, 0);
process.stdout.write(JSON.stringify({ imported, warnings: report.warnings, arrivedAt, doneAt: Date.now() }));
`;

interface WorkerOut {
  readonly imported: number;
  readonly warnings: string[];
  readonly arrivedAt: number;
  readonly doneAt: number;
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

/** Every worker waits at a barrier until all are loaded, then the imports overlap; the timestamps prove it. */
async function race(roots: readonly string[]): Promise<WorkerOut[]> {
  writeFileSync(join(w.dir, 'worker.mjs'), WORKER, 'utf8');
  const barrier = join(w.dir, 'barrier');
  const done = await Promise.all(roots.map((root, i) => runWorker([distUrl('agent-memories/sync.js'), root, w.home, barrier, String(i), String(roots.length)])));
  for (const d of done) expect(d.code, d.stderr).toBe(0);
  // SAFETY: the worker prints one JSON object with these fields.
  const outs = done.map((d) => JSON.parse(d.stdout) as WorkerOut);
  expect(Math.max(...outs.map((o) => o.arrivedAt)), 'a worker finished before the last one started').toBeLessThanOrEqual(Math.min(...outs.map((o) => o.doneAt)));
  return outs;
}

describe('agent memory sync: concurrent first imports', () => {
  it('four processes importing the same 40 notes into one fresh store give exactly one row per note', async () => {
    for (let i = 0; i < NOTES; i++) note(projectNotes(w), `n${i}.md`, `Race note ${i}: build ${i + 100} needs the schema check first.`);

    const outs = await race(Array.from({ length: WORKERS }, () => w.local));
    expect(outs.reduce((n, o) => n + o.imported, 0)).toBe(NOTES);
    expect(agentRows(w.local)).toHaveLength(NOTES);
    expect(new Set(liveRows(w.local).map((e) => e.source)).size).toBe(NOTES);
  }, 120_000);

  it('four projects\' sleeps racing on the user pass give one global row per Codex bullet', async () => {
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
