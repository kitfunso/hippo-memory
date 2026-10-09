// CLI flags are read through the named readers in src/cli/flag-values.ts, never with an inline typeof ternary or cast.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { boolFlag, flagIsTrue, numberFlag, stringFlag, type CliFlags } from '../src/cli/flag-values.js';

const cases: ReadonlyArray<[string, CliFlags]> = [
  ['absent', {}],
  ['value-less', { x: true }],
  ['string', { x: 'abc' }],
  ['empty string', { x: '' }],
  ['array', { x: ['a', 'b'] }],
];

describe('flag readers', () => {
  it('stringFlag returns only a real string', () => {
    expect(cases.map(([, f]) => stringFlag(f, 'x'))).toEqual([undefined, undefined, 'abc', '', undefined]);
  });

  it('numberFlag parses only a real string', () => {
    expect(numberFlag({ x: '12' }, 'x')).toBe(12);
    expect(numberFlag({ x: '1abc' }, 'x')).toBeNaN();
    expect(cases.map(([, f]) => numberFlag(f, 'x'))).toEqual([undefined, undefined, NaN, 0, undefined]);
  });

  it('boolFlag is truthiness', () => {
    expect(cases.map(([, f]) => boolFlag(f, 'x'))).toEqual([false, true, true, false, true]);
  });

  it('flagIsTrue accepts only a bare switch', () => {
    expect(cases.map(([, f]) => flagIsTrue(f, 'x'))).toEqual([false, true, false, false, false]);
  });
});

describe('inline flag reads', () => {
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) return sourceFiles(full);
      return d.name.endsWith('.ts') ? [full] : [];
    });
  const files = [path.resolve('src/cli.ts'), ...sourceFiles(path.resolve('src/cli'))].filter(
    (f) => path.basename(f) !== 'flag-values.ts' || !f.includes(`${path.sep}cli${path.sep}`),
  );
  const INLINE = /typeof flags\[[^\]]+\]\s*===\s*'string'\s*\?|flags\[[^\]]+\]\s+as string(?!\[)/;

  it('src/cli has no typeof-string ternary or string cast on a flag', () => {
    const hits = files.filter((f) => INLINE.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative('.', f));
    expect(hits).toEqual([]);
  });
});
