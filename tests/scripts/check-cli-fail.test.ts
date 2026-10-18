import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { failPairLines, findFailPairs } from '../../scripts/check-cli-fail.mjs';

describe('check-cli-fail', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-fail-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('flags a printError followed by throw new CliExit(1), on one line, two lines or across a multi-line call', () => {
    const text = [
      "printError('a');",
      'throw new CliExit(1);',
      'if (x) { printError(`b ${f(")")}`); throw new CliExit(1); }',
      'printError(',
      "  'c',",
      '  `d (${y})`,',
      ');',
      '',
      'throw new CliExit(1);',
    ].join('\n');
    expect(failPairLines(text)).toEqual([1, 3, 4]);
  });

  it('skips another exit code, no throw after, other statements between, a braceless loop or if body, comments and fail()', () => {
    const text = [
      "printError('a');",
      'throw new CliExit(2);',
      "printError('b');",
      'return;',
      "printError('c');",
      'log();',
      'throw new CliExit(1);',
      "// printError('d'); throw new CliExit(1);",
      "fail('e');",
      'for (const line of usage) printError(line);',
      'throw new CliExit(1);',
      "if (x) printError('f');",
      'throw new CliExit(1);',
    ].join('\n');
    expect(failPairLines(text)).toEqual([]);
  });

  it('scans cli.ts and cli/ only, and reports files with their lines', () => {
    file('cli.ts', "export const ok = fail('x');\n");
    file('cli/bad.ts', "import { x } from './x.js';\nprintError('no');\nthrow new CliExit(1);\n");
    file('cli/sub/good.ts', "fail('yes');\n");
    file('core/other.ts', "printError('no');\nthrow new CliExit(1);\n");
    expect(findFailPairs(dir)).toEqual([{ file: 'cli/bad.ts', line: 2 }]);
  });

  it('passes on the real src tree', () => {
    expect(findFailPairs(join(__dirname, '..', '..', 'src'))).toEqual([]);
  });
});
