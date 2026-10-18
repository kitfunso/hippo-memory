import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findLongLists, LIMIT, SKIPPED } from '../../scripts/check-positional-params.mjs';

function inFixture<T>(files: Record<string, string>, body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'hippo-positional-params-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const params = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}: number`).join(', ');

describe('check-positional-params.mjs', () => {
  it('limits a declaration to five positional parameters', () => {
    expect(LIMIT).toBe(6);
    inFixture({ 'src/a.ts': `export function ok(${params(5)}) {}\n` }, (root) => {
      expect(findLongLists(root)).toEqual([]);
    });
  });

  it('names a function with six, with its file, line and count', () => {
    const text = `export const one = 1;\nexport function tooMany(${params(6)}) {}\n`;
    inFixture({ 'src/a.ts': text }, (root) => {
      expect(findLongLists(root)).toEqual([{ site: 'src/a.ts:2 tooMany', count: 6 }]);
    });
  });

  it('counts methods, constructors, arrows, signatures and function types as well', () => {
    const text = [
      `export class Box { constructor(${params(6)}) {} run(${params(6)}) {} }`,
      `export const arrow = (${params(7)}) => 0;`,
      `export interface Port { read(${params(6)}): void }`,
      `export type Hook = (${params(6)}) => void;`,
    ].join('\n');
    inFixture({ 'src/a.ts': text }, (root) => {
      expect(findLongLists(root).map((hit) => hit.site)).toEqual([
        'src/a.ts:1 constructor',
        'src/a.ts:1 run',
        'src/a.ts:2 arrow',
        'src/a.ts:3 read',
        'src/a.ts:4 (anonymous)',
      ]);
    });
  });

  it('counts a destructured options object as one parameter', () => {
    const text = `export function run({ a, b, c, d, e, f, g }: Record<string, number>, h: number) {}\n`;
    inFixture({ 'src/a.ts': text }, (root) => {
      expect(findLongLists(root)).toEqual([]);
    });
  });

  it('counts a rest parameter and a this parameter as none', () => {
    const text = [
      `export function rest(...args: [number, number, number, number, number, number, number]) {}`,
      `export function pinned(this: Box, ${params(5)}) {}`,
      `export function tail(${params(5)}, ...more: number[]) {}`,
      `interface Box {}`,
    ].join('\n');
    inFixture({ 'src/a.ts': text }, (root) => {
      expect(findLongLists(root)).toEqual([]);
    });
  });

  it('reads files in nested folders but not .d.ts files or folders outside src', () => {
    const long = `export function wide(${params(6)}) {}\n`;
    inFixture(
      { 'src/deep/er/a.ts': long, 'src/types.d.ts': long, 'scripts/job.ts': long, 'tests/a.ts': long },
      (root) => {
        expect(findLongLists(root).map((hit) => hit.site)).toEqual(['src/deep/er/a.ts:1 wide']);
      },
    );
  });

  it('leaves the store adapters out, and counts the rest of src/store', () => {
    const long = `export function wide(${params(6)}) {}\n`;
    expect(SKIPPED).toEqual(['src/store/sqlite/', 'src/store/port/']);
    inFixture(
      { 'src/store/sqlite/a.ts': long, 'src/store/port/b.ts': long, 'src/store/search-rows.ts': long },
      (root) => {
        expect(findLongLists(root).map((hit) => hit.site)).toEqual(['src/store/search-rows.ts:1 wide']);
      },
    );
  });

  it('lists the declarations at or above a lower floor too', () => {
    inFixture({ 'src/a.ts': `export function four(${params(4)}) {}\n` }, (root) => {
      expect(findLongLists(root, 4)).toEqual([{ site: 'src/a.ts:1 four', count: 4 }]);
    });
  });
});
