import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findProcessExits, processExitLines } from '../scripts/check-process-exit.mjs';

describe('check-process-exit', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'process-exit-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('counts dot, optional-chain and bracket calls, each call once, and skips comments', () => {
    const text = [
      'process.exit(1);',
      "process['exit'](2);",
      '// process.exit(3) in a comment',
      'if (a) process.exit(4); else process?.exit(5);',
      '/* process.exit(6) in a block */ const exitCode = process.exitCode;',
    ].join('\n');
    expect(processExitLines(text)).toEqual([1, 2, 4, 4]);
  });

  it('fails a new call in a file that is not listed, with its line', () => {
    file('entry.ts', 'process.exit(1);\n');
    file('cli/verb.ts', 'export function run(): void {\n  process.exit(2);\n}\n');
    file('cli/clean.ts', 'export const x = 1;\n');
    expect(findProcessExits(dir, { 'entry.ts': { count: 1, reason: 'the entry' } }))
      .toEqual([{ file: 'cli/verb.ts', line: 2, found: 1, allowed: 0 }]);
  });

  it('fails a listed file that holds one call more than its count, and passes it at the count', () => {
    const allowed = { 'entry.ts': { count: 2, reason: 'the entry' } };
    file('entry.ts', 'process.exit(1);\nprocess.exit(2);\n');
    expect(findProcessExits(dir, allowed)).toEqual([]);
    file('entry.ts', 'process.exit(1);\nprocess.exit(2);\nprocess.exit(3);\n');
    expect(findProcessExits(dir, allowed).map((hit) => [hit.line, hit.found, hit.allowed])).toEqual([[1, 3, 2], [2, 3, 2], [3, 3, 2]]);
  });

  it('passes on the real src tree', () => {
    expect(findProcessExits(resolve(__dirname, '..', 'src'))).toEqual([]);
  });
});
