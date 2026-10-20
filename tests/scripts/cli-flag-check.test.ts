import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findHandFlagReads, handFlagLines } from '../../scripts/check-cli-flags.mjs';

describe('check-cli-flags', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-flags-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('flags String(), template and `as string` reads of a flag, and skips comments and list casts', () => {
    const text = [
      "const a = String(flags['task'] ?? '');",
      'const b = String(flags.task);',
      'const c = `${flags["task"]}`;',
      "const d = flags['task'] as string;",
      'const e = flags.task as string;',
      "// const f = String(flags['in-a-comment']);",
      '(flags[key] as string[]).push(value);',
      "const g = `x${flags['global'] ? ' --global' : ''}`;",
      "const h = stringFlagOrExit(flags, 'task') ?? '';",
    ].join('\n');
    expect(handFlagLines(text)).toEqual([1, 2, 3, 4, 5]);
  });

  it('scans cli.ts and surface/cli/ only, and reports files with their lines', () => {
    file('cli.ts', 'export const ok = 1;\n');
    file('surface/cli/a.ts', "import { x } from './x.js';\nexport const y = String(flags['summary'] ?? '');\n");
    file('surface/cli/sub/b.ts', 'export const z = 1;\n');
    file('base/c.ts', "export const w = String(flags['summary']);\n");
    expect(findHandFlagReads(dir)).toEqual([{ file: 'surface/cli/a.ts', line: 2 }]);
  });
});
