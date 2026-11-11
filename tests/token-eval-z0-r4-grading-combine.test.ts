// Round 4 G5 per batch: z0-grading-combine counts every folder's latest reader round together, as round 3's combine script did.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../scripts/token-eval/z0-grading-combine.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

interface Pair { file: string; which: string; verdict: string }
interface Extra { flippedLessons?: string[]; acceptanceFlips?: number; storedSample?: ReturnType<typeof stored>; g5?: { readerRound: number | null } }
const put = <T>(file: string, value: T) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
};

/** A run folder with its grading.json and the sealed round-1 key and score it was counted from; `wrong` labels each listed pair against its verdict. */
function folder(root: string, name: string, pairs: Pair[], wrong: string[], extra: Extra = {}, says?: { n: number; disagreements: number }) {
  const dir = path.join(root, name);
  const labels = Object.fromEntries(pairs.map((p) => [p.file, wrong.includes(p.file) ? 'other' : p.verdict]));
  put(path.join(dir, 'g5', 'sealed', 'reader-r1.key.json'), { pairs });
  put(path.join(dir, 'g5', 'sealed', 'reader-r1.score.json'), { labels });
  put(path.join(dir, 'grading.json'), { g5: { readerRound: 1 }, readerSample: says ?? { n: pairs.length, disagreements: wrong.length }, flippedLessons: [], acceptanceFlips: 0, ...extra });
  return path.join(dir, 'grading.json');
}
const pairs = (prefix: string, first: number, final: number): Pair[] => [
  ...Array.from({ length: first }, (_, i) => ({ file: `${prefix}-f${i}`, which: 'first', verdict: 'pass' })),
  ...Array.from({ length: final }, (_, i) => ({ file: `${prefix}-g${i}`, which: 'final', verdict: 'fail' })),
];
const stored = (table: { yesYes: number; yesNo: number; noYes: number; noNo: number }, excluded: Record<string, number>) => {
  const n = table.yesYes + table.yesNo + table.noYes + table.noNo;
  return { n, agree: table.yesYes + table.noNo, agreement: 0.5, ci95: [0.1, 0.9], kappa: 0.5, table, excluded };
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('z0-grading-combine', () => {
  afterEach(cleanup);

  function scene(withStored = false) {
    const root = tmp('z0-combine-');
    // An undefined storedSample is left out of the JSON, so a folder without one has none.
    const storedA = withStored ? stored({ yesYes: 4, yesNo: 1, noYes: 1, noNo: 4 }, { cut: 1 }) : undefined;
    const storedB = withStored ? stored({ yesYes: 3, yesNo: 0, noYes: 2, noNo: 5 }, { cut: 2, empty: 1 }) : undefined;
    const a = folder(root, 'a', pairs('a', 3, 2), ['a-f0', 'a-g1'], { flippedLessons: ['L2', 'L1'], acceptanceFlips: 1, storedSample: storedA });
    const b = folder(root, 'b', pairs('b', 4, 1), ['b-f3'], { flippedLessons: ['L1', 'L3'], acceptanceFlips: 2, storedSample: storedB });
    return { root, a, b, out: path.join(root, 'grading.json') };
  }

  it('sums the readers\' pairs, splits first and final checks from the sealed round and merges the flipped lessons', () => {
    const s = scene();
    const result = runCli(['--grading', s.a, '--grading', s.b, '--out', s.out]);
    expect(result).toMatchObject({ code: 0, stdout: `wrote ${s.out}: G5 reads 10 pairs (7 first-check), 3 flipped lessons, 3 acceptance flips\n` });
    const combined = read(s.out);
    expect(combined).toMatchObject({
      acceptanceFlips: 3, flippedLessons: ['L1', 'L2', 'L3'], readerSample: { disagreements: 3, n: 10 },
      g5: { allPairs: { disagreements: 3, n: 10 }, firstPairs: { disagreements: 2, n: 7 }, finalPairs: { disagreements: 1, n: 3 } },
    });
    expect(combined.g5.folders.map((f: { file: string; sha256: string }) => [f.file, f.sha256])).toEqual([s.a, s.b].map((f) => [f, createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
    expect(combined).not.toHaveProperty('storedSample');
  });

  it('pools the stored samples when every folder scored one, and refuses a partial set', () => {
    const s = scene(true);
    expect(runCli(['--grading', s.a, '--grading', s.b, '--out', s.out])).toMatchObject({ code: 0, stdout: expect.stringContaining(', stored sample n 20') });
    expect(read(s.out).storedSample).toMatchObject({ n: 20, agree: 16, agreement: 0.8, table: { yesYes: 7, yesNo: 1, noYes: 3, noNo: 9 }, excluded: { cut: 3, empty: 1 } });
    const bare = folder(s.root, 'c', pairs('c', 2, 0), []);
    expect(runCli(['--grading', s.a, '--grading', bare, '--out', s.out])).toMatchObject({ code: 1, stderr: expect.stringContaining('stored sample scored in 1 of 2 folders') });
  });

  it('writes the same bytes on a rerun, and reads a single file', () => {
    const s = scene();
    runCli(['--grading', s.a, '--grading', s.b, '--out', s.out]);
    const first = fs.readFileSync(s.out, 'utf8');
    expect(runCli(['--grading', s.a, '--grading', s.b, '--out', s.out])).toMatchObject({ code: 0 });
    expect(fs.readFileSync(s.out, 'utf8')).toBe(first);
    expect(runCli(['--grading', s.a, '--out', s.out])).toMatchObject({ code: 0, stdout: expect.stringContaining('G5 reads 5 pairs (3 first-check)') });
  });

  it('exits 1 naming the file on a recount that differs, a folder with no scored round and a pair with another check', () => {
    const root = tmp('z0-combine-bad-');
    const off = folder(root, 'off', pairs('o', 2, 1), ['o-f0'], {}, { n: 3, disagreements: 0 });
    expect(runCli(['--grading', off, '--out', path.join(root, 'x.json')])).toMatchObject({ code: 1, stderr: expect.stringContaining(`${off}: sealed round 1 recounts to 1 of 3, the grading file says 0 of 3`) });
    const none = folder(root, 'none', pairs('n', 1, 0), [], { g5: { readerRound: null } });
    expect(runCli(['--grading', none, '--out', path.join(root, 'x.json')])).toMatchObject({ code: 1, stderr: expect.stringContaining(`${none}: no scored reader round`) });
    const odd = folder(root, 'odd', [{ file: 'p', which: 'third', verdict: 'pass' }], []);
    expect(runCli(['--grading', odd, '--out', path.join(root, 'x.json')])).toMatchObject({ code: 1, stderr: expect.stringContaining('has check third, not first or final') });
    expect(fs.existsSync(path.join(root, 'x.json'))).toBe(false);
  });

  it('exits 1 with its usage on a missing flag', () => {
    expect(runCli(['--grading', 'g.json'])).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
    expect(runCli(['--out', 'x.json'])).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
  });
});
