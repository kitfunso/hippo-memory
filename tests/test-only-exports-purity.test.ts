import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { judgeExports } from '../scripts/check-test-only-exports.mjs';

const CALC = `
export function double(n: number): number { return n * 2; }
export const half = (n: number): number => n / 2;
export function orphan(n: number): number { return n + 1; }
export const LIMIT = 10;
export class Meter { total = 0; add(n: number): number { this.total += n; return this.total; } }
function drive(): number { return double(half(LIMIT)) + new Meter().add(1); }
export const driven = drive();
`;

const STATE = `
let counter = 0;
const stats = { runs: 0 };
const seen = new Map<string, number>([['a', 1]]);
export const table: number[] = [1];
export function bump(): number { counter += 1; return counter; }
export function readCounter(): number { return counter; }
export function readRuns(): number { return stats.runs; }
export function seenCount(): number { return seen.size; }
export function tableSize(): number { return table.length; }
export function shadowed(counter: number): number { return counter + 1; }
function tick(): number { stats.runs++; seen.set('b', 2); return readCounter() + readRuns() + seenCount() + tableSize() + shadowed(1); }
export const ticked = tick();
`;

const REPORT = `
import { rowCount } from './db/rows.js';
import { slurp } from './disk.js';
export function describeRows(): string { return String(rowCount()); }
export function firstLine(path: string): string { return slurp(path).split('\\n')[0] ?? ''; }
export function shout(text: string): string { console.log(text); return text.toUpperCase(); }
export function home(): string { return process.env.HOME ?? ''; }
export function ping(n: number): string { return n > 0 ? pong(n - 1) : firstLine('x'); }
export function pong(n: number): string { return n > 0 ? ping(n - 1) : ''; }
export const shown = [describeRows(), firstLine('a'), shout('b'), home(), ping(2)];
`;

const RATES = `
export const RATE = 3;
export function viaNamed(): number { return 1; }
export function viaNamespace(): number { return 2; }
export function viaLoader(): number { return 3; }
export function viaBarrel(): number { return 4; }
export function onlyNamed(): number { return 5; }
`;

const TEST_NAMES = 'double half orphan LIMIT Meter readCounter readRuns seenCount tableSize shadowed describeRows firstLine shout home ping pong RATE viaNamed viaNamespace viaLoader viaBarrel onlyNamed';

describe('check-test-only-exports.mjs: script callers and the purity rule', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'test-only-exports-'));
    file('package.json', JSON.stringify({ exports: { '.': './dist/index.js' } }));
    file('layers.json', JSON.stringify({ folders: { db: 'db' }, rootFiles: {} }));
    file('src/index.ts', 'export const entry = 1;\n');
    file('src/calc.ts', CALC);
    file('src/state.ts', STATE);
    file('src/grow.ts', `import { table } from './state.js';\nexport function grow(): void { table.push(2); }\n`);
    file('src/db/rows.ts', 'export function rowCount(): number { return 1; }\n');
    file('src/disk.ts', `import { readFileSync } from 'node:fs';\nexport function slurp(path: string): string { return readFileSync(path, 'utf8'); }\n`);
    file('src/report.ts', REPORT);
    file('src/rates.ts', RATES);
    file('src/barrel.ts', `export * from './rates.js';\n`);
    file('tests/names.test.ts', `// ${TEST_NAMES}\n`);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  /** The names of one src file that the gate still counts as test-only. */
  function counted(srcFile: string): string[] {
    return judgeExports(dir)
      .filter((r: { key: string; counted: boolean }) => r.counted && r.key.startsWith(`src/${srcFile}:`))
      .map((r: { key: string }) => r.key.slice(r.key.lastIndexOf(':') + 1));
  }

  it('does not count a pure function, arrow function or class that its own module calls', () => {
    expect(counted('calc.ts')).toEqual(['LIMIT', 'orphan']);
  });

  it('counts a pure function with no caller, and a constant even though its module reads it', () => {
    const rows = judgeExports(dir);
    expect(rows.find((r: { key: string }) => r.key === 'src/calc.ts:orphan')).toEqual({ key: 'src/calc.ts:orphan', counted: true, why: 'no caller in its own module' });
    expect(rows.find((r: { key: string }) => r.key === 'src/calc.ts:LIMIT')).toEqual({ key: 'src/calc.ts:LIMIT', counted: true, why: 'not a function or class' });
  });

  it('counts a function that reads a reassigned let, and not one whose parameter shares the name', () => {
    expect(counted('state.ts')).toContain('readCounter');
    expect(counted('state.ts')).not.toContain('shadowed');
  });

  it('counts a function that reads a const object or map that code writes to, in its module or through an import', () => {
    expect(counted('state.ts')).toEqual(['readCounter', 'readRuns', 'seenCount', 'tableSize']);
  });

  it('counts a function that reaches the db layer, fs through a second module, console or process.env', () => {
    expect(counted('report.ts')).toEqual(expect.arrayContaining(['describeRows', 'firstLine', 'home', 'shout']));
  });

  it('counts both halves of a mutual recursion when only one of them reaches fs', () => {
    expect(counted('report.ts')).toEqual(expect.arrayContaining(['ping', 'pong']));
  });

  it('counts every export of a module that no script imports', () => {
    expect(counted('rates.ts')).toEqual(['RATE', 'onlyNamed', 'viaBarrel', 'viaLoader', 'viaNamed', 'viaNamespace']);
  });

  it('takes a script or benchmark that imports the module as a caller, and ignores one that only shares the identifier', () => {
    file('scripts/eval.mjs', `import { RATE, viaNamed } from '../dist/rates.js';\nimport { viaBarrel } from '../dist/barrel.js';\nconsole.log(RATE, viaNamed(), viaBarrel());\n`);
    file('benchmarks/run.mjs', `import * as rates from '../dist/rates.js';\nconsole.log(rates.viaNamespace());\n`);
    file('scripts/loader.mjs', `const load = (f) => import(new URL('../dist/' + f, import.meta.url));\nconst { viaLoader } = await load('rates.js');\nviaLoader();\n`);
    file('scripts/unrelated.mjs', `import { slurp } from '../dist/disk.js';\nconst onlyNamed = slurp;\nconsole.log(onlyNamed);\n`);
    expect(counted('rates.ts')).toEqual(['onlyNamed']);
  });
});
