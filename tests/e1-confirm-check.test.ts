// confirm-check.mjs (docs/evals/2026-09-28-e1-release-confirmation-prereg.md): the R4 seed screen, the seed-spec
// guard, the params check, and split's agreement with compare.mjs on one set of synthetic run files.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPTS = path.resolve(__dirname, '..', 'scripts', 'e1-lifecycle');
const LOCK = '2026-09-28T12:30:36+01:00';
const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8' });

let dir = '';
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-e1-confirm-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// No stale hits, so compare.mjs's cleanStaleR5 is the same quantity as split's updatedR5.
function writeRun(arm: string, seed: number, hitOf: (i: number) => boolean, meta: { halfLife?: number; ranAt?: string } = {}): void {
  const probes = Array.from({ length: 40 }, (_, i) => ({
    factId: i, hot: i % 2 === 0, staleEligible: i % 3 === 0, trapEligible: false, contraEligible: false,
    hit: hitOf(i), rank: 0, staleHit: false, trapHit: false, contraHit: false,
  }));
  const file = { meta: { protocolHash: `h${seed}`, arm, seed, ...meta }, epochs: [{ probes }] };
  fs.writeFileSync(path.join(dir, `${arm}-seed${seed}.json`), JSON.stringify(file));
}

describe('confirm-check.mjs', () => {
  it("split's two lines match compare.mjs to the digit on the same files", () => {
    // Eight seeds of 40 probes: on three seeds of ten, a different bootstrap stream gave the same 95% bounds.
    for (let s = 1; s <= 8; s++) {
      writeRun('x', s, (i) => (i * i + s * 7) % 5 < 3);
      writeRun('y', s, (i) => (i * 3 + s * s) % 7 < 4);
    }
    const cmp = run('compare.mjs', ['--a', `${dir}:x`, '--b', `${dir}:y`, '--seeds', '1-8']);
    const split = run('confirm-check.mjs', ['split', `${dir}:x`, `${dir}:y`, '1-8']);
    expect(cmp.status, cmp.stderr).toBe(0);
    expect(split.status, split.stderr).toBe(0);
    const line = (out: string, metric: string) => out.split('\n').find((l) => l.startsWith(`${metric} |`))?.slice(metric.length);
    expect(line(split.stdout, 'nonStaleR5')).toMatch(/\[/);
    expect(line(split.stdout, 'nonStaleR5')).toBe(line(cmp.stdout, 'nonStaleR5'));
    expect(line(split.stdout, 'updatedR5')).toMatch(/\[/);
    expect(line(split.stdout, 'updatedR5')).toBe(line(cmp.stdout, 'cleanStaleR5'));
  });

  it('refuses a bad, reversed or repeated seed spec before reading any file', () => {
    for (const [spec, msg] of [['5-3', /bad seed spec: 5-3/], ['1,x', /bad seed spec: 1,x/], ['1,2,1', /repeated seed in 1,2,1/]] as const) {
      const r = run('confirm-check.mjs', ['diff', `${dir}:nope`, `${dir}:nope`, spec]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(msg);
    }
  });

  it('params passes a 365-day run made after the lock and names every wrong field', () => {
    writeRun('full', 7, () => true, { halfLife: 365, ranAt: '2026-09-28T13:00:00.000Z' });
    writeRun('bm25-static', 7, () => true, { halfLife: 7, ranAt: '2026-09-28T11:00:00.000Z' });
    const ok = run('confirm-check.mjs', ['params', dir, 'full', '7', 'all', LOCK]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/PASS/);
    const late = run('confirm-check.mjs', ['params', dir, 'bm25-static', '7', 'all', LOCK]);
    expect(late.status).not.toBe(0);
    expect(late.stderr).toMatch(/halfLife 7, ranAt 2026-09-28T11:00:00\.000Z/);
    const window = run('confirm-check.mjs', ['params', dir, 'full', '7', 'v1', LOCK]);
    expect(window.status).not.toBe(0);
    expect(window.stderr).toMatch(/lookalikeWindow undefined/);
  });

  it('r4-seeds skips seed 89, with 50.8% of lookalikes dated after v1, and keeps 20 others', () => {
    const r = run('confirm-check.mjs', ['r4-seeds', '81', '20']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/seed 89: .* 50\.8% v1 window, SKIP/);
    const kept = r.stdout.match(/R4 seeds: (.*)/)?.[1].trim().split(',') ?? [];
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain('89');
  }, 30_000);
});
