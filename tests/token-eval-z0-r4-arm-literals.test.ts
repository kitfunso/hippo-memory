// Round 4 prereg item 1: arm codes live in the arm table and the designs only, so no other harness file names one.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const DIR = path.resolve(__dirname, '..', 'scripts', 'token-eval');
// The four patterns of the plan's scanner (S/planA/scanner.sh): a quoted code, a first-letter test, a first-character index and a code as an object key.
const PATTERNS = [/['"`](A|X|O|S)[0-9]['"`]/, /startsWith\(['"][A-Z]['"]\)/, /arm\[0\]/, /\b(A|X|O|S)[0-9]: /];

/** `text` with each comment blanked and every line break kept, so code after a closed block comment is scanned and a hit keeps its line number.
 * A quote opens a string in which '//' and '/*' are text; ' and " strings stop at the line end, as in JavaScript. */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const [c, next] = [text[i]!, text[i + 1]];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The 1-based line numbers of `text` that a pattern matches once comment text is stripped. */
function hits(text: string): number[] {
  return withoutComments(text).split('\n').flatMap((line, i) => (PATTERNS.some((p) => p.test(line)) ? [i + 1] : []));
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

  it('flags a planted sample of each pattern, and code that trails or follows a comment', () => {
    for (const sample of ["const a = 'A1';", 'const b = "S0";', 'const c = `O1`;', "run.arm.startsWith('A')", 'const d = arm[0];', 'const e = { X2: 1 };',
      "/* x */ const a = 'A1';", "/** x */ const a = 'A1';", "const u = 'http://x'; const a = 'A1';", "// note\nconst a = 'A1';"]) {
      expect(hits(sample).length, sample).toBeGreaterThan(0);
    }
    expect(hits("/* x */\n/* y */ const a = 'A1';")).toEqual([2]);
    expect(hits("const a = 1; /* skip */ const b = 'S2';")).toEqual([1]);
  });

  it('skips a code that sits inside a comment only, on one line or several', () => {
    for (const sample of ["// the arm 'A1' runs", "const ok = 1; // 'A1' runs", '/* arm[0] */', "/* const a = 'A1'; */", "/**\n * 'S2' is a twin\n * { X2: 1 }\n */", "/* a */ /* 'S0' */", 'const ok = ARM_TABLE[arm].group;']) {
      expect(hits(sample), sample).toEqual([]);
    }
  });
});
