import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findFolderCycles, findImportCycles, FOLDER_CYCLE_ALLOWLIST, judgeFolderCycles, runtimeSpecifiers } from '../scripts/check-import-cycles.mjs';

describe('check-import-cycles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'import-cycles-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('passes an acyclic graph', () => {
    file('a.ts', `import { b } from './b.js';\nexport const a = b;\n`);
    file('b.ts', `import { c } from './sub/c.js';\nexport const b = c;\n`);
    file('sub/c.ts', `export const c = 1;\n`);
    expect(findImportCycles(dir)).toEqual([]);
  });

  it('reports a two-module cycle and a longer one through a subdirectory and a re-export', () => {
    file('a.ts', `import { b } from './b.js';\nexport const a = () => b;\n`);
    file('b.ts', `import {\n  a,\n} from './a.js';\nexport const b = () => a;\n`);
    file('x.ts', `import * as y from './sub/y.js';\nexport const x = y;\n`);
    file('sub/y.ts', `export { z } from '../z.js';\n`);
    file('z.ts', `import './x.js';\nexport const z = 1;\n`);
    expect(findImportCycles(dir)).toEqual([
      { modules: ['a.ts', 'b.ts'], edges: [['a.ts', 'b.ts'], ['b.ts', 'a.ts']] },
      { modules: ['sub/y.ts', 'x.ts', 'z.ts'], edges: [['sub/y.ts', 'z.ts'], ['x.ts', 'sub/y.ts'], ['z.ts', 'x.ts']] },
    ]);
  });

  it('ignores type-only imports, commented imports and dynamic import()', () => {
    file('a.ts', `import type { B } from './b.js';\nimport { type C } from './c.js';\nexport type A = B | C;\n`);
    file('b.ts', `// import { a } from './a.js';\nexport type B = string;\nexport async function load() { return import('./a.js'); }\n`);
    file('c.ts', `export type { A } from './a.js';\nexport type C = number;\n`);
    expect(findImportCycles(dir)).toEqual([]);
  });

  it('keeps a mixed value-and-type import as a runtime edge', () => {
    expect(runtimeSpecifiers(`import { type T, value } from './m.js';\nimport Default, { type U } from './n.js';\n`))
      .toEqual(['./m.js', './n.js']);
  });

  it('reports two folders that import each other through different files, which the file check passes', () => {
    file('search/rank.ts', `import { scopeOf } from '../sharing/scope.js';\nexport const rank = scopeOf;\n`);
    file('sharing/scope.ts', `export const scopeOf = 1;\n`);
    file('sharing/both.ts', `import { rank } from '../search/rank.js';\nexport const both = rank;\n`);
    file('core/x.ts', `export const x = 1;\n`);
    file('cli.ts', `import { both } from './sharing/both.js';\nimport { x } from './core/x.js';\nexport const cli = [both, x];\n`);
    expect(findImportCycles(dir)).toEqual([]);
    expect(findFolderCycles(dir)).toEqual([{
      folders: ['search', 'sharing'],
      edges: [['search/rank.ts', 'sharing/scope.ts'], ['sharing/both.ts', 'search/rank.ts']],
    }]);
  });

  it('skips a type-only import between folders', () => {
    file('a/one.ts', `import type { Two } from '../b/two.js';\nexport type One = Two;\nexport const one = 1;\n`);
    file('b/two.ts', `import { one } from '../a/one.js';\nexport type Two = number;\nexport const two = one;\n`);
    expect(findFolderCycles(dir)).toEqual([]);
  });

  it('passes an allowlisted folder cycle and fails an allowlist entry that matches no cycle', () => {
    const none: [string, string][] = [];
    const cycles = [{ folders: ['mcp', 'server'], edges: none }, { folders: ['core', 'util'], edges: none }];
    const allowlist = [{ folders: ['server', 'mcp'], why: 'w' }, { folders: ['search', 'sharing'], why: 'gone' }];
    expect(judgeFolderCycles(cycles, allowlist)).toEqual({ unlisted: [cycles[1]], stale: [allowlist[1]] });
  });

  it('finds no folder cycle in src and keeps no allowlist entry', () => {
    expect(findFolderCycles(join(import.meta.dirname, '..', 'src'))).toEqual([]);
    expect(FOLDER_CYCLE_ALLOWLIST).toEqual([]);
  });
});
