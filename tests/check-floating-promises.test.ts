import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { findFloatingPromises } from '../scripts/check-floating-promises.mjs';

// Parsing the real ES2022 lib took 6.5 s on a CI runner, past the unit budget; the check only needs these globals.
const MINIMAL_LIB = [
  'interface Array<T> { length: number; [n: number]: T }',
  'interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {}',
  'interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}',
  'interface PromiseLike<T> { then<A = T, B = never>(ok?: (v: T) => A | PromiseLike<A>, no?: (e: unknown) => B | PromiseLike<B>): PromiseLike<A | B> }',
  'interface Promise<T> {',
  '  then<A = T, B = never>(ok?: (v: T) => A | PromiseLike<A>, no?: (e: unknown) => B | PromiseLike<B>): Promise<A | B>;',
  '  catch<B = never>(no?: (e: unknown) => B | PromiseLike<B>): Promise<T | B>;',
  '  finally(done?: () => void): Promise<T>;',
  '}',
  'interface PromiseConstructor { new <T>(run: (ok: (v: T) => void, no: (e: unknown) => void) => void): Promise<T> }',
  'declare var Promise: PromiseConstructor;',
].join('\n');

describe('check-floating-promises', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'floating-promises-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** The hits for one source file, compiled on its own. */
  function hitsFor(body: string): { line: number; text: string }[] {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    const file = join(src, 'entry.ts');
    const lib = join(dir, 'lib.d.ts');
    writeFileSync(file, body, 'utf8');
    writeFileSync(lib, MINIMAL_LIB, 'utf8');
    const program = ts.createProgram([lib, file], { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, noLib: true });
    return findFloatingPromises(program, src).map(({ line, text }) => ({ line, text }));
  }

  it('flags a promise call statement that nothing awaits', () => {
    const body = [
      'async function work(): Promise<number> { return 1; }',
      'async function main(): Promise<void> {',
      '  work();',
      '  await work();',
      '}',
      'void main;',
    ].join('\n');
    expect(hitsFor(body)).toEqual([{ line: 3, text: 'work();' }]);
  });

  it('passes a .catch, a two-argument .then, a .finally after either, and void', () => {
    const body = [
      'async function work(): Promise<number> { return 1; }',
      'work().catch(() => 0);',
      'work().then(() => 0, () => 0);',
      'work().catch(() => 0).finally(() => {});',
      'work().then(() => 0, () => 0).then(() => 1);',
      'void work();',
    ].join('\n');
    expect(hitsFor(body)).toEqual([]);
  });

  it('flags a one-argument .then or a .finally with no handler before it', () => {
    const body = [
      'async function work(): Promise<number> { return 1; }',
      'work().then(() => 0);',
      'work().finally(() => {});',
    ].join('\n');
    expect(hitsFor(body).map((h) => h.line)).toEqual([2, 3]);
  });

  it('ignores calls that do not return a promise', () => {
    expect(hitsFor('function plain(): number { return 1; }\nplain();\n')).toEqual([]);
  });
});
