// A pre-session snapshot copy that fails (EBUSY on Windows) never abandons the run; the retry says the restore failed.
import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { __setSurfaceCopy } from '../scripts/token-eval/surfaces.mjs';
import { cleanup, isolate, makeRepo, task, plain, spec, run, readRecords, readPlan, readLedger, find } from './fixtures/z0-harness.js';

afterEach(() => {
  __setSurfaceCopy(null);
  cleanup();
});

const busyPreSession: typeof cpSync = (from, to, opts) => {
  if (/[\\/]snap[\\/].*[\\/]pre-session[\\/]/.test(String(to))) throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${String(from)}'`), { code: 'EBUSY' });
  return cpSync(from, to, opts);
};

describe('a failed snapshot copy', () => {
  it('marks the snapshot unrestorable and the retry unrestored, and the run goes on', async () => {
    const { out } = isolate('snapfail');
    const r = makeRepo();
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(out, 'limit-hit');
    __setSurfaceCopy(busyPreSession);
    const said: string[] = [];
    await run(spec(r, [], [task(r, 'n1', 'LIMIT LIMIT_SURFACES look around'), plain(r, 'n2')]), ['A2'], out, { limitWaitMs: 0, log: (m) => said.push(m) });
    const recs = readRecords(out);
    expect(recs).toHaveLength(readPlan(out).length);
    expect(find(recs, 'A2', 'n1')).toMatchObject({ invalid: null, limitRetries: 1, surfaceRestored: false });
    expect(find(recs, 'A2', 'n2')).toMatchObject({ invalid: null, limitRetries: 0, surfaceRestored: true });
    expect(existsSync(join(out, 'ABANDONED'))).toBe(false);
    const pre = readLedger(out).find((l) => l.taskId === 'n1' && l.when === 'pre-session')!;
    expect(pre.restorable).toBe(false);
    expect(pre.copyErrors.map((e) => e.code)).toContain('EBUSY');
    expect(said.some((m) => /n1 A2 seed1: pre-session copy of \w+ failed \(EBUSY\)/.test(m))).toBe(true);
  }, 300_000);
});
