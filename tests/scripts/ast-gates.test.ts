import { describe, expect, it } from 'vitest';
import { readFacts, runtimeSpecifiers } from '../../scripts/lib/ts-facts.mjs';

const imports = (text: string) =>
  readFacts(text).imports.map((i) => [i.kind, i.spec, i.line, i.typeOnly, i.names.join(',')]);

describe('ts-facts imports', () => {
  it('ignores an import inside a string, a template or a comment', () => {
    const text = [
      'const s = "import { a } from \'./a.js\'";',
      "const t = `import { b } from './b.js'`;",
      "// import { c } from './c.js';",
      "/* import './d.js'; */",
      "import { real } from './real.js';",
    ].join('\n');
    expect(imports(text)).toEqual([['import', './real.js', 5, false, 'real']]);
  });

  it('reads a multi-line import and reports the line of the import keyword', () => {
    expect(imports("\nimport {\n  a,\n  b as c,\n} from './m.js';\n")).toEqual([['import', './m.js', 2, false, 'a,b']]);
  });

  it('tells import type, all-type specifiers and a mixed list apart', () => {
    const text = [
      "import type { A } from './a.js';",
      "import { type B, type C } from './b.js';",
      "import { type D, e } from './c.js';",
      "import Default, { type F } from './d.js';",
      "import type * as G from './e.js';",
    ].join('\n');
    expect(imports(text).map(([, spec, , typeOnly]) => [spec, typeOnly])).toEqual([
      ['./a.js', true],
      ['./b.js', true],
      ['./c.js', false],
      ['./d.js', false],
      ['./e.js', true],
    ]);
    expect(runtimeSpecifiers(text)).toEqual(['./c.js', './d.js']);
  });

  it('reads export-from forms, with star and namespace re-exports reaching every name', () => {
    const text = [
      "export * from './a.js';",
      "export * as ns from './b.js';",
      "export { x, y as z } from './c.js';",
      "export type { T } from './d.js';",
      "export { type U } from './e.js';",
      'export { local };',
    ].join('\n');
    expect(imports(text)).toEqual([
      ['export', './a.js', 1, false, '*'],
      ['export', './b.js', 2, false, '*'],
      ['export', './c.js', 3, false, 'x,y'],
      ['export', './d.js', 4, true, 'T'],
      ['export', './e.js', 5, true, 'U'],
    ]);
  });

  it('counts a side-effect import, and no dynamic import, which loads lazily', () => {
    const text = [
      "import './setup.js';",
      "const a = await import('./lazy.js');",
      'const b = await import(`./dir/${name}.js`);',
    ].join('\n');
    expect(imports(text)).toEqual([['side-effect', './setup.js', 1, false, '*']]);
    expect(runtimeSpecifiers(text)).toEqual(['./setup.js']);
  });
});
