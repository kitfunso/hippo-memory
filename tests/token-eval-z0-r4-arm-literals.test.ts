// Round 4 prereg item 1: arm codes live in the arm table and the designs only, so no other harness file names one.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const DIR = path.resolve(__dirname, '..', 'scripts', 'token-eval');
// The four patterns of the plan's scanner (S/planA/scanner.sh): a quoted code, a first-letter test, a first-character index and a code as an object key.
const PATTERNS = [/['"`](A|X|O|S)[0-9]['"`]/, /startsWith\(['"][A-Z]['"]\)/, /arm\[0\]/, /\b(A|X|O|S)[0-9]: /];

/** `text` with each comment blanked and every line break kept, so code after a closed block comment is scanned and a hit keeps its line number.
 * TypeScript's parser tells the tokens apart, so a regex, string or template that holds '//' or '/*' is never read as a comment. */
function withoutComments(text: string): string {
  const source = ts.createSourceFile('scanned.mjs', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const out = text.split('');
  const visit = (node: ts.Node): void => {
    // A JSDoc node only repeats a comment that the token after it holds in its own leading text.
    const children = node.getChildren(source).filter((c) => !ts.isJSDoc(c));
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    // Only whitespace and comments sit between a token's full start and its own start.
    for (let i = node.pos; i < node.getStart(source); i++) if (!/\s/.test(out[i]!)) out[i] = ' ';
  };
  visit(source);
  return out.join('');
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
      "/* x */ const a = 'A1';", "/** x */ const a = 'A1';", "const u = 'http://x'; const a = 'A1';", "// note\nconst a = 'A1';",
      "const slash = /\\//; const arm = 'A1';", "const re = /\\/*/; const a = 'A1';", "const re = /[/*]/; const a = 'A1';", "const t = `${'//'}`; const a = 'A1';"]) {
      expect(hits(sample).length, sample).toBeGreaterThan(0);
    }
    expect(hits("/* x */\n/* y */ const a = 'A1';")).toEqual([2]);
    expect(hits("const a = 1; /* skip */ const b = 'S2';")).toEqual([1]);
    expect(hits("const re = /[/*]/;\nconst a = 'A1';")).toEqual([2]);
  });

  it('skips a code that sits inside a comment only, on one line or several', () => {
    for (const sample of ["// the arm 'A1' runs", "const ok = 1; // 'A1' runs", '/* arm[0] */', "/* const a = 'A1'; */", "/**\n * 'S2' is a twin\n * { X2: 1 }\n */", "/* a */ /* 'S0' */", 'const ok = ARM_TABLE[arm].group;', "const slash = /\\//; // 'A1' runs", "const re = /[/*]/; /* 'S2' */"]) {
      expect(hits(sample), sample).toEqual([]);
    }
  });
});
