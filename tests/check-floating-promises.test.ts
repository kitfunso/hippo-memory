import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { findFloatingApiCalls } from '../scripts/check-floating-api.mjs';
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

// The checker's cold start is pure CPU, so a loaded runner stretched the first compile past the 5 s unit default even with the small lib.
describe('check-floating-promises', { timeout: 30_000 }, () => {
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

describe('check-floating-api', { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'floating-api-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** The hits for one test file that imports a stand-in forget from src/api/memories/forget.ts. */
  function hitsFor(body: string): { file: string; line: number; why: string }[] {
    mkdirSync(join(dir, 'src', 'api', 'memories'), { recursive: true });
    mkdirSync(join(dir, 'tests'));
    const files = {
      'lib.d.ts': `${MINIMAL_LIB}\ndeclare function expect(x: unknown): { rejects: unknown; toThrow(): void };`,
      'src/api/memories/forget.ts': 'export async function forget(id: string): Promise<string> { return id; }\nexport async function other(): Promise<number> { return 1; }\n',
      'tests/use.test.ts': `import { forget, other } from '../src/api/memories/forget';\n${body}`,
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8');
    const program = ts.createProgram(Object.keys(files).map((name) => join(dir, name)), {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, noLib: true,
    });
    return findFloatingApiCalls(program, dir).map(({ file, line, why }) => ({ file, line, why }));
  }

  it('flags a dropped api write and a sync expect callback that returns one', () => {
    const body = [
      'async function main(): Promise<void> {',
      "  forget('a');",
      "  forget('a').then(() => 0);",
      "  expect(() => forget('a')).toThrow();",
      '}',
      'void main;',
    ].join('\n');
    expect(hitsFor(body)).toEqual([
      { file: 'tests/use.test.ts', line: 3, why: 'dropped' },
      { file: 'tests/use.test.ts', line: 4, why: 'dropped' },
      { file: 'tests/use.test.ts', line: 5, why: 'sync expect' },
    ]);
  });

  it('passes an awaited, returned, void or handled call, an async expect, and other promises', () => {
    const body = [
      'async function main(): Promise<string> {',
      "  await forget('a');",
      "  void forget('a');",
      "  forget('a').catch(() => 0);",
      "  await expect(forget('a')).rejects;",
      "  expect(async () => forget('a'));",
      '  other();',
      "  return forget('a');",
      '}',
      'void main;',
    ].join('\n');
    expect(hitsFor(body)).toEqual([]);
  });
});
