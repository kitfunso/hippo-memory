// Round 4 prereg item 1: arm codes live in the arm table and the designs only, so no other harness file names one.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const DIR = path.resolve(__dirname, '..', 'scripts', 'token-eval');
// The four patterns of the plan's scanner (S/planA/scanner.sh): a quoted code, a first-letter test, a first-character index and a code as an object key.
const PATTERNS = [/['"`](A|X|O|S)[0-9]['"`]/, /startsWith\(['"][A-Z]['"]\)/, /arm\[0\]/, /\b(A|X|O|S)[0-9]: /];
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/** The 1-based line numbers of `text` that a pattern matches, comment lines skipped. */
function hits(text: string): number[] {
  return text.split('\n').flatMap((line, i) => (!COMMENT.test(line) && PATTERNS.some((p) => p.test(line)) ? [i + 1] : []));
}

describe('arm literals (round 4 prereg :104)', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs'));

  it('finds no code outside arms.mjs', () => {
    const found = files.filter((f) => f !== 'arms.mjs').flatMap((f) => hits(fs.readFileSync(path.join(DIR, f), 'utf8')).map((n) => `${f}:${n}`));
    expect(found).toEqual([]);
  });

  it('finds a code in arms.mjs only between the arm-table markers', () => {
    const lines = fs.readFileSync(path.join(DIR, 'arms.mjs'), 'utf8').split('\n');
    const [start, end] = [lines.findIndex((l) => l.includes('arm-table:start')) + 1, lines.findIndex((l) => l.includes('arm-table:end')) + 1];
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const outside = hits(lines.join('\n')).filter((n) => n < start || n > end);
    expect(outside).toEqual([]);
  });

  it('flags a planted sample of each pattern and skips a comment', () => {
    for (const sample of ["const a = 'A1';", 'const b = "S0";', 'const c = `O1`;', "run.arm.startsWith('A')", 'const d = arm[0];', 'const e = { X2: 1 };']) {
      expect(hits(sample), sample).toEqual([1]);
    }
    for (const sample of ["// the arm 'A1' runs", " * 'S2' is a twin", '/* arm[0] */', 'const ok = ARM_TABLE[arm].group;']) {
      expect(hits(sample), sample).toEqual([]);
    }
  });
});
