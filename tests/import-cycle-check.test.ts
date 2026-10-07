import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findImportCycles, runtimeSpecifiers } from '../scripts/check-import-cycles.mjs';

describe('check-import-cycles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'import-cycles-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('the real src/ tree has no runtime import cycle', () => {
    expect(findImportCycles('src')).toEqual([]);
  });

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
});
