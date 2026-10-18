import { describe, expect, it } from 'vitest';
import { failPairLines } from '../../scripts/check-cli-fail.mjs';
import { handFlagLines } from '../../scripts/check-cli-flags.mjs';
import { namedOnLines } from '../../scripts/check-cli-recall-writes.mjs';
import { envReadLines } from '../../scripts/check-env-reads.mjs';
import { processExitLines } from '../../scripts/check-process-exit.mjs';
import { readFacts, runtimeSpecifiers } from '../../scripts/lib/ts-facts.mjs';

const imports = (text: string) => readFacts(text).imports.map((i) => [i.kind, i.spec, i.line, i.typeOnly, i.names.join(',')]);

describe('ts-facts imports', () => {
  it('ignores an import inside a string, a template or a comment', () => {
    const text = [
      "const s = \"import { a } from './a.js'\";",
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
      ['./a.js', true], ['./b.js', true], ['./c.js', false], ['./d.js', false], ['./e.js', true],
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

  it('counts a side-effect import and a literal dynamic import, and skips a template-literal one', () => {
    const text = ["import './setup.js';", "const a = await import('./lazy.js');", 'const b = await import(`./dir/${name}.js`);'].join('\n');
    expect(imports(text)).toEqual([
      ['side-effect', './setup.js', 1, false, '*'],
      ['dynamic', './lazy.js', 2, false, '*'],
    ]);
    expect(runtimeSpecifiers(text)).toEqual(['./setup.js']);
  });
});

describe('ts-facts calls, env reads and functions', () => {
  it('lists calls by callee name in any spelling and skips comments and strings', () => {
    const text = [
      'loadConfig(root);',
      "process['exit'](1);",
      'process?.exit(2);',
      '// process.exit(3)',
      "const s = 'loadConfig(x)';",
      'cfg.loadConfig(root);',
    ].join('\n');
    expect(readFacts(text).calls.map((c) => [c.callee, c.line])).toEqual([
      ['loadConfig', 1], ['process.exit', 2], ['process.exit', 3], ['cfg.loadConfig', 6],
    ]);
  });

  it('finds process.env as a member, a bracket read and a destructure, and not env in a string', () => {
    const text = [
      'const a = process.env.HOME;',
      "const b = process['env'];",
      'const { env } = process;',
      'let env2; ({ env: env2 } = globalThis.process);',
      "const s = 'process.env';",
      'const { cwd } = process;',
    ].join('\n');
    expect(readFacts(text).envReads.map((r) => r.line)).toEqual([1, 2, 3, 4]);
  });

  it('lists exported function declarations with their first parameter name', () => {
    const text = [
      'export function a(hippoRoot: string): void {}',
      'export async function b<T>(hippoRoot: string, x: T): Promise<void> {}',
      'export function c(ctx: Ctx, hippoRoot: string): void {}',
      'function d(hippoRoot: string): void {}',
      'export const e = (hippoRoot: string) => hippoRoot;',
      'export function f(): void {}',
    ].join('\n');
    expect(readFacts(text).exportedFunctions).toEqual([
      { name: 'a', firstParam: 'hippoRoot' },
      { name: 'b', firstParam: 'hippoRoot' },
      { name: 'c', firstParam: 'ctx' },
      { name: 'f', firstParam: null },
    ]);
  });
});

describe('gates read code, not text that looks like code', () => {
  it('process.exit and process.env gates skip strings, template text and comments', () => {
    const text = ["const s = 'process.exit(1) and process.env';", 'const t = `process.exit(2)`;', '// process.env', 'process.exit(3);', 'const e = process.env.X;'].join('\n');
    expect(processExitLines(text)).toEqual([4]);
    expect(envReadLines(text)).toEqual([5]);
  });

  it('the flag gate flags String(flags.x), a template span and an as-string cast, and not a list cast or a string', () => {
    const text = ["const a = String(flags.x ?? '');", 'const b = `${flags.y}`;', 'const c = flags.z as string;', 'const d = flags.w as string[];', "const e = 'String(flags.q)';"].join('\n');
    expect(handFlagLines(text)).toEqual([1, 2, 3]);
  });

  it('the fail gate pairs printError with the next statement only, inside a multi-line call too', () => {
    const text = ['printError(', "  `bad ${x}`,", ');', 'throw new CliExit(1);', 'if (c) printError(y);', 'throw new CliExit(1);', "printError('z');", 'throw new CliExit(2);'].join('\n');
    expect(failPairLines(text)).toEqual([1]);
  });

  it('the recall gate matches identifiers, imports included, and not the same word in a string', () => {
    const text = ["import { writeEntry } from './w.js';", "const msg = 'writeEntry failed';", '// writeEntry', 'writeEntry(x);'].join('\n');
    expect(namedOnLines(text, ['writeEntry'])).toEqual([{ line: 1, name: 'writeEntry' }, { line: 4, name: 'writeEntry' }]);
  });
});
