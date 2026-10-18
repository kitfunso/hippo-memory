// CLI flags are read through the named readers in src/cli/flag-values.ts, never with an inline typeof ternary or cast.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  boolFlag,
  flagIsTrue,
  intFlagInRange,
  numberFlag,
  parseCountFlag,
  parseLimitFlag,
  parsePositiveId,
  repeatedFlag,
  stringFlag,
  type CliFlags,
} from '../../src/cli/flag-values.js';
import { CliExit } from '../../src/cli/exit.js';
import type { IntRange } from '../../src/cli/flag-values.js';

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
    expect(cases.filter(([n]) => n !== 'string' && n !== 'empty string').map(([, f]) => numberFlag(f, 'x'))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('integer flags refuse a value that is not all digits', () => {
    expect([parseLimitFlag('12'), parseCountFlag('12')]).toEqual([12, 12]);
    for (const bad of ['12abc', ' 12']) {
      expect([parseLimitFlag(bad), parseCountFlag(bad)]).toEqual([Infinity, 0]);
    }
  });

  it('boolFlag is truthiness', () => {
    expect(cases.map(([, f]) => boolFlag(f, 'x'))).toEqual([false, true, true, false, true]);
  });

  it('flagIsTrue accepts only a bare switch', () => {
    expect(cases.map(([, f]) => flagIsTrue(f, 'x'))).toEqual([false, true, false, false, false]);
  });
});

describe('repeatedFlag', () => {
  it('answers the repeated values, a one-item list for a single value and an empty list otherwise', () => {
    expect(cases.map(([, f]) => repeatedFlag(f, 'x'))).toEqual([[], [], ['abc'], [''], ['a', 'b']]);
  });

  it('does not split a single value on commas', () => {
    expect(repeatedFlag({ x: 'a,b' }, 'x')).toEqual(['a,b']);
  });
});

describe('intFlagInRange', () => {
  const range: IntRange = { min: 1, max: 3, example: '2' };
  const refusal = (flags: CliFlags, r: IntRange = range): string => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => intFlagInRange(flags, 'hops', r).fail?.()).toThrow(CliExit);
      return String(err.mock.calls[0]?.[0]);
    } finally {
      err.mockRestore();
    }
  };

  it('answers nothing for an absent flag and the number for one in range', () => {
    expect(intFlagInRange({}, 'hops', range)).toEqual({});
    expect(intFlagInRange({ hops: '2' }, 'hops', range)).toEqual({ value: 2 });
    expect(intFlagInRange({ hops: '0' }, 'hops', { min: 0, max: 3 })).toEqual({ value: 0 });
  });

  it('refuses a value-less flag apart from a junk one', () => {
    expect(refusal({ hops: true })).toBe('--hops requires an integer value 1..3 (e.g. --hops 2).');
    expect(refusal({ hops: true }, { min: 1 })).toBe('--hops requires a positive integer value.');
    expect(refusal({ hops: 'x' })).toBe('Invalid --hops: "x". Must be an integer 1..3.');
  });

  it.each(['0', '4', '1.5', '-1', 'abc'])('refuses %s outside 1..3', (raw) => {
    expect(refusal({ hops: raw })).toBe(`Invalid --hops: "${raw}". Must be an integer 1..3.`);
  });

  it('has no upper bound without a max', () => {
    expect(intFlagInRange({ hops: '9000' }, 'hops', { min: 1 })).toEqual({ value: 9000 });
    expect(refusal({ hops: '0' }, { min: 1 })).toBe('Invalid --hops: "0". Must be a positive integer.');
  });
});

describe('parsePositiveId', () => {
  it('reads a whole positive number and refuses the rest', () => {
    expect(parsePositiveId('12', 'handoff')).toBe(12);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const bad of ['12abc', '1.5', '0', '-3', '']) {
        expect(() => parsePositiveId(bad, 'handoff')).toThrow(CliExit);
      }
      expect(String(err.mock.calls[0]?.[0])).toBe('Invalid handoff id: "12abc" (expected a positive integer).');
    } finally {
      err.mockRestore();
    }
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
