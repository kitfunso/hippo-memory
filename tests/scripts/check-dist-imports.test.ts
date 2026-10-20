import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkDistImports, distImports } from '../../scripts/check-dist-imports.mjs';

describe('distImports', () => {
  it('reads static, dynamic and distImport forms, skips erased types, and ignores code inside strings', () => {
    const text = [
      "import { a, type T, b as c } from '../dist/x.js';",
      "import type { U } from '../dist/types.js';",
      "import def, * as all from '../dist/y.js';",
      "export { d } from '../dist/z.js';",
      "import { local } from './util.js';",
      "const { e, f: g } = await import('../../dist/w.js');",
      "const lazy = import(new URL('../dist/v.js', import.meta.url));",
      "const { h } = await import(pathToFileURL(path.join(REPO, 'dist', 'base/u.js')).href);",
      "const { i } = await distImport('base/t.js');",
      "const fixture = `import { zz } from '../dist/none.js'`;",
    ].join('\n');
    expect(distImports(text, 'probe.ts')).toEqual([
      { line: 1, spec: '../dist/x.js', fromRepo: false, names: ['a', 'b'] },
      { line: 3, spec: '../dist/y.js', fromRepo: false, names: ['default'] },
      { line: 4, spec: '../dist/z.js', fromRepo: false, names: ['d'] },
      { line: 6, spec: '../../dist/w.js', fromRepo: false, names: ['e', 'f'] },
      { line: 7, spec: '../dist/v.js', fromRepo: false, names: [] },
      { line: 8, spec: 'dist/base/u.js', fromRepo: true, names: ['h'] },
      { line: 9, spec: 'dist/base/t.js', fromRepo: true, names: ['i'] },
    ]);
  });
});

describe('checkDistImports', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'dist-imports-'));
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(repo, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('names imports that do not load or lack a value, and passes types, fixture dists and allowed ones', async () => {
    file('dist/mod.js', 'export const a = 1;\nexport function b() {}\n');
    file(
      'dist/mod.d.ts',
      'export declare const a = 1;\nexport declare function b(): void;\nexport interface Shape {}\n',
    );
    file('scripts/ok.mjs', "import { a, b } from '../dist/mod.js';\nawait import('../dist/mod.js');\n");
    file('scripts/gone.mjs', "import { a, c } from '../dist/mod.js';\n");
    file('benchmarks/moved.mjs', "const { a } = await import('../dist/old.js');\n");
    file('evals/helper.mjs', "const { b } = await distImport('mod.js');\nawait distImport('none.js');\n");
    file('tests/types.ts', "import { a, Shape } from '../dist/mod.js';\nimport type { T } from '../dist/old.js';\n");
    file('tests/fixtures/pkg/index.mjs', "import { x } from './dist/own.js';\n");
    const { checked, problems } = await checkDistImports(repo);
    expect(checked).toBe(7);
    expect(problems).toEqual([
      { file: 'benchmarks/moved.mjs', line: 1, spec: '../dist/old.js', problem: 'is not built' },
      { file: 'evals/helper.mjs', line: 2, spec: 'dist/none.js', problem: 'is not built' },
      { file: 'scripts/gone.mjs', line: 1, spec: '../dist/mod.js', problem: 'lacks c' },
    ]);
    const allowed = { 'scripts/gone.mjs -> ../dist/mod.js': 'test' };
    expect((await checkDistImports(repo, { allowed })).problems.map((p) => p.file)).toEqual([
      'benchmarks/moved.mjs',
      'evals/helper.mjs',
    ]);
  });
});
