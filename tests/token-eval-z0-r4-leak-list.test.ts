// Round 4 prereg item 9: z0-leaks lists the (sequence, seed)s G3 counts as leaked, through the one filter path and with no price file.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { assertSameCount, runCli } from '../scripts/token-eval/z0-leaks.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { generate, jsonl, type Z0Record } from './fixtures/z0-gen.js';

const corpus = (leaks: [string, number][], invalid = false) => {
  const g = generate({ design: DESIGNS.r4, repos: 3 });
  for (const [sequence, seed] of leaks) {
    const hit = g.records.find((r: Z0Record) => r.sequence === sequence && r.seed === seed && r.position === 4)!;
    Object.assign(hit, invalid ? { invalid: 'leak', leak: true, resolved: false } : { leak: true });
  }
  const dir = tmp('z0-leaks-');
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), jsonl(g.records));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(g.plan));
  return dir;
};
const args = (dir: string, extra: string[] = []) => ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--out', 'leaks.json', ...extra, '--design', 'r4'];
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'leaks.json'), 'utf8'));

describe('z0-leaks (prereg item 9)', () => {
  afterEach(cleanup);

  it('writes the two (sequence, seed)s a synthetic round 4 first run leaked, sorted, and prints one line each', () => {
    const dir = corpus([['rn-repo3', 2], ['rn-repo1', 3]]);
    const result = runCli(args(dir), dir);
    expect(result).toMatchObject({ code: 0, stdout: 'rn-repo1 3\nrn-repo3 2\n' });
    const file = read(dir);
    expect(file).toMatchObject({ schema: 'z0-leaks/1', leaks: [{ sequence: 'rn-repo1', seed: 3 }, { sequence: 'rn-repo3', seed: 2 }] });
    expect(file.runs.sha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(dir, 'runs.jsonl'))).digest('hex'));
    expect(path.resolve(file.runs.file)).toBe(path.join(dir, 'runs.jsonl'));
  });

  it('counts a leak written as an invalid leak record the same way, and a seed once however many records leak', () => {
    const dir = corpus([['rn-repo2', 1]], true);
    const text = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').split('\n').map((l): Z0Record => JSON.parse(l));
    const second = text.find((r) => r.sequence === 'rn-repo2' && r.seed === 1 && r.position === 6)!;
    second.leak = true;
    fs.writeFileSync(path.join(dir, 'runs.jsonl'), jsonl(text));
    expect(runCli(args(dir), dir)).toMatchObject({ code: 0, stdout: 'rn-repo2 1\n' });
  });

  it('writes an empty list when nothing leaked', () => {
    const dir = corpus([]);
    expect(runCli(args(dir), dir)).toMatchObject({ code: 0, stdout: '' });
    expect(read(dir).leaks).toEqual([]);
  });

  it('exits 1 with checkDesignArms\' line when the design is left out, since the loader defaults to round 3', () => {
    const dir = corpus([['rn-repo1', 2]]);
    const result = runCli(['--runs', 'runs.jsonl', '--plan', 'plan.json', '--out', 'leaks.json'], dir);
    expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('is not in design r3; pass the design that holds it') });
    expect(fs.existsSync(path.join(dir, 'leaks.json'))).toBe(false);
  });

  it('exits 1 with its usage on a missing flag or an unknown design', () => {
    const dir = corpus([]);
    expect(runCli(['--runs', 'runs.jsonl'], dir)).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
    expect(runCli([...args(dir).slice(0, 6), '--design', 'r9'], dir)).toMatchObject({ code: 1, stderr: expect.stringContaining('unknown design r9') });
  });

  it('stops with both counts when the list and G3\'s figure differ', () => {
    expect(() => assertSameCount(2, 2)).not.toThrow();
    expect(() => assertSameCount(2, 3)).toThrow('STOP: 2 leaks listed, G3 counts 3');
  });
});
