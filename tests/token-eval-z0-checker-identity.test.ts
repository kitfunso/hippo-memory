// Z0 G5 (prereg 166): which files a lesson checker's identity holds, which imports stop the load, and what stays outside.
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkerIdentity } from '../scripts/token-eval/checker-identity.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

type Files = Record<string, string>;
const at = (dir: string, entry = 'check.mjs', args: string[] = []) => checkerIdentity({ checkPath: join(dir, entry), check: { script: entry, args } });
const put = (dir: string, files: Files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
const fresh = (files: Files) => put(tmp('z0-ident-'), files);
const body = (file: string, v: number) => (file.endsWith('.json') ? `{ "v": ${v} }\n` : file.endsWith('.mjs') ? `export const v = ${v};\n` : `module.exports = { v: ${v} };\n`);
/** Whether a new body in `helper` gives the checker another identity. */
const moves = (files: Files, entry: string, helper: string) => {
  const d = fresh({ ...files, [helper]: body(helper, 1) });
  const before = at(d, entry);
  writeFileSync(join(d, helper), body(helper, 2));
  return at(d, entry) !== before;
};
const IMPORTS_HELPER = "import { v } from './helper.mjs';\nconsole.log(v);\n";
const TICK = '`';

describe('checker identity is content, not path (27d-27i)', () => {
  afterEach(cleanup);

  it('the same entry bytes with a different sibling helper are another checker (27d)', () => {
    const a = put(tmp('z0-ident-'), { 'check.mjs': IMPORTS_HELPER, 'helper.mjs': 'export const v = 1;\n' });
    const b = put(tmp('z0-ident-'), { 'check.mjs': IMPORTS_HELPER, 'helper.mjs': 'export const v = 2;\n' });
    expect(at(a)).not.toBe(at(b));
  });

  it('a copied folder, or a renamed entry, is the same checker (27e)', () => {
    const files = { 'check.mjs': IMPORTS_HELPER, 'helper.mjs': 'export const v = 1;\n' };
    const a = put(tmp('z0-ident-'), files);
    const b = put(tmp('z0-ident-'), files);
    expect(at(a)).toBe(at(b));
    writeFileSync(join(b, 'renamed.mjs'), IMPORTS_HELPER);
    expect(at(b, 'renamed.mjs')).toBe(at(a));
  });

  it('an import cycle ends, and a byte in the far file changes the identity (27f)', () => {
    const d = put(tmp('z0-ident-'), { 'check.mjs': "import './a.mjs';\n", 'a.mjs': "import './b.mjs';\n", 'b.mjs': "import './a.mjs';\n// one\n" });
    const before = at(d);
    writeFileSync(join(d, 'b.mjs'), "import './a.mjs';\n// two\n");
    expect(at(d)).not.toBe(before);
  });

  it.each([
    ['named import', 'check.mjs', "import { v } from './h.mjs';\n", 'h.mjs'],
    ['bare import', 'check.mjs', "import './h.mjs';\n", 'h.mjs'],
    ['multi-line import', 'check.mjs', 'import {\n  v,\n} from "./h.mjs";\n', 'h.mjs'],
    ['export star', 'check.mjs', "export * from './h.mjs';\n", 'h.mjs'],
    ['dynamic import', 'check.mjs', "const m = await import('./h.mjs');\n", 'h.mjs'],
    ['require in cjs', 'check.cjs', "const m = require('./h.cjs');\n", 'h.cjs'],
  ])('follows a %s (27g)', (_name, entry, text, helper) => {
    const d = put(tmp('z0-ident-'), { [entry]: text, [helper]: '// one\n' });
    const before = at(d, entry);
    writeFileSync(join(d, helper), '// two\n');
    expect(at(d, entry)).not.toBe(before);
  });

  it('an import that names no file throws and names the specifier (27h)', () => {
    const d = put(tmp('z0-ident-'), { 'check.cjs': "require('./helper');\n", 'helper.js': '// here\n' });
    expect(() => at(d, 'check.cjs')).toThrow('./helper');
  });

  it('a string that only looks like an import is ignored (27i)', () => {
    const a = put(tmp('z0-ident-'), { 'check.mjs': 'const BAD = "from \'./legacy.mjs\'";\n' });
    expect(() => at(a)).not.toThrow();
    const b = put(tmp('z0-ident-'), { 'check.mjs': 'const BAD = "from \'./legacy.mjs\'";\n' });
    expect(at(a)).toBe(at(b));
  });
});

describe('checker identity follows every local import written with a plain string', () => {
  afterEach(cleanup);

  it.each<[name: string, entry: string, text: string, helper: string]>([
    ['a BOM before the import (U1)', 'check.mjs', "\uFEFFimport { v } from './h.mjs';\nconsole.log(v);\n", 'h.mjs'],
    ['a second import on one line (U2)', 'check.mjs', "import * as fs from 'node:fs'; import { v } from './h.mjs';\nconsole.log(v, typeof fs);\n", 'h.mjs'],
    ['an apostrophe in a comment inside the clause (U3)', 'check.mjs', "import {\n  v, // don't drop this\n} from './h.mjs';\nconsole.log(v);\n", 'h.mjs'],
    ['a semicolon in a comment inside the clause (U3b)', 'check.mjs', "import {\n  v, // the verdict; see README\n} from './h.mjs';\nconsole.log(v);\n", 'h.mjs'],
    ['import() with a plain template literal (U4)', 'check.mjs', `const { v } = await import(${TICK}./h.mjs${TICK});\nconsole.log(v);\n`, 'h.mjs'],
    ['require() with a plain template literal (U4b)', 'check.cjs', `const { v } = require(${TICK}./h.cjs${TICK});\nconsole.log(v);\n`, 'h.cjs'],
    ['a block comment before the import on its line (U6)', 'check.mjs', "/* eslint-disable */ import { v } from './h.mjs';\nconsole.log(v);\n", 'h.mjs'],
    ['a string-named import binding (U9)', 'check.mjs', "import { \"v\" as w } from './h.mjs';\nconsole.log(w);\n", 'h.mjs'],
    ['an import after a statement on one line', 'check.mjs', "const n = 1; import { v } from './h.mjs';\nconsole.log(v, n);\n", 'h.mjs'],
    ['a require of a folder whose name starts with two dots', 'check.cjs', "console.log(require('..lib/h.cjs').v);\n", '..lib/h.cjs'],
  ])('follows %s', (_name, entry, text, helper) => {
    expect(moves({ [entry]: text }, entry, helper)).toBe(true);
  });

  // Shapes the two regular expressions already followed, kept so the parser cannot lose them.
  it.each<[name: string, entry: string, text: string, helper: string]>([
    ['an import on the line after an import with no semicolon (U12)', 'check.mjs', "import * as fs from 'node:fs'\nimport { v } from './h.mjs'\nconsole.log(v, typeof fs)\n", 'h.mjs'],
    ['createRequire saved as require in an .mjs', 'check.mjs', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconsole.log(require('./h.cjs').v);\n", 'h.cjs'],
    ['an import() inside a function body', 'check.mjs', "async function load() {\n  return (await import('./h.mjs')).v;\n}\nconsole.log(await load());\n", 'h.mjs'],
    ['a re-export by name', 'check.mjs', "export { v } from './h.mjs';\n", 'h.mjs'],
    ['a JSON import with an attribute', 'check.mjs', "import d from './d.json' with { type: 'json' };\nconsole.log(d.v);\n", 'd.json'],
    ['a require inside a try', 'check.cjs', "let v = 0;\ntry {\n  v = require('./h.cjs').v;\n} catch {\n  v = -1;\n}\nconsole.log(v);\n", 'h.cjs'],
    ['an import after a hashbang line', 'check.mjs', "#!/usr/bin/env node\nimport { v } from './h.mjs';\nconsole.log(v);\n", 'h.mjs'],
    ['a helper in a parent folder', 'checks/check.mjs', "import { v } from '../shared/h.mjs';\nconsole.log(v);\n", 'shared/h.mjs'],
    ['require in brackets, and called with new', 'check.cjs', "console.log((require)('./h.cjs').v, new require('./h.cjs').v);\n", 'h.cjs'],
    ['an import after a top-level await of a regular expression', 'check.mjs', `const r = await /${TICK}/.test('x');\nconst { v } = await import('./h.mjs');\nconsole.log(v, r); // ${TICK};\n`, 'h.mjs'],
    ['a require after a division by a variable named await', 'check.cjs', `var await = 4, g = 2;\nvar r = await / 2 //${TICK}\nconst { v } = require('./h.cjs'); // ${TICK}/g\nconsole.log(v, r);\n`, 'h.cjs'],
    ['a require after "a < b >" and a regular expression, which is no type argument list in JavaScript', 'check.cjs', `var a = 1, b = 2, g = 1;\nvar r = a < b > /${TICK}/.test('x'); const { v } = require('./h.cjs'); //${TICK}/g\nconsole.log(v, r);\n`, 'h.cjs'],
    ['a class that extends a required base', 'check.cjs', "class A extends require('./h.cjs') {}\nclass B extends A {}\nconsole.log(new B());\n", 'h.cjs'],
    ['a conditional whose else branch is an arrow function', 'check.cjs', "var flag = 0;\nconst pick = flag ? (flag) : (m) => m.v;\nconsole.log(pick(require('./h.cjs')));\n", 'h.cjs'],
    ['an import after a top-level await of a bracketed regular expression that holds a quote', 'check.mjs', "const r = await (/\"/).test('x');\nconst { v } = await import('./h.mjs');\nconsole.log(v, r);\n", 'h.mjs'],
    ['the same bracketed regular expression in a .js file', 'check.js', "const r = await (/\"/).test('x');\nconst { v } = await import('./h.mjs');\nconsole.log(v, r);\n", 'h.mjs'],
    ['a require after "<", a space and a regular expression', 'check.cjs', "var a = 1;\nvar ok = a < /re/.test(String(require('./h.cjs').v));\nconsole.log(ok);\n", 'h.cjs'],
    ['a bracketed arrow function in a nested conditional', 'check.cjs', "var x = 1, y = 0, b = 2;\nvar f = x ? y ? (b) : (c => require('./h.cjs').v) : 0;\nconsole.log(f());\n", 'h.cjs'],
    ['a .node helper, which counts by its bytes and is never parsed', 'check.cjs', "console.log(require('./h.node'));\n", 'h.node'],
  ])('still follows %s', (_name, entry, text, helper) => {
    expect(moves({ [entry]: text }, entry, helper)).toBe(true);
  });

  it('reads a .js file both as CommonJS and as an ES module, since package.json picks one', () => {
    const esm = `const r = await /${TICK}/.test('x');\nconst { v } = await import('./h.mjs');\nconsole.log(v, r); // ${TICK};\n`;
    expect(moves({ 'check.js': esm, 'package.json': '{ "type": "module" }\n' }, 'check.js', 'h.mjs')).toBe(true);
    const cjs = `var await = 4, g = 2;\nvar r = await / 2 //${TICK}\nconst { v } = require('./h.cjs'); // ${TICK}/g\nconsole.log(v, r);\n`;
    expect(moves({ 'check.js': cjs }, 'check.js', 'h.cjs')).toBe(true);
  });

  it('resolves a linked helper\'s own imports from its real folder, as Node does (U14)', () => {
    const d = fresh({
      'real/h.mjs': "export { v } from '../dep.mjs';\n", 'dep.mjs': body('dep.mjs', 1),
      'chk/check.mjs': "import { v } from './lib/h.mjs';\nconsole.log(v);\n", 'chk/dep.mjs': 'export const v = 99;\n',
    });
    symlinkSync(join(d, 'real'), join(d, 'chk', 'lib'), 'junction');
    const before = at(join(d, 'chk'));
    writeFileSync(join(d, 'dep.mjs'), body('dep.mjs', 2));
    expect(at(join(d, 'chk'))).not.toBe(before);
  });

  it('equal bytes in check.cjs and check.mjs are two checkers; a rename that keeps the extension is one', () => {
    const bytes = "const fs = require('node:fs');\nconsole.log(typeof fs.readFileSync);\n";
    const d = fresh({ 'check.cjs': bytes, 'check.mjs': bytes, 'renamed.cjs': bytes });
    expect(at(d, 'check.cjs')).not.toBe(at(d, 'check.mjs'));
    expect(at(d, 'renamed.cjs')).toBe(at(d, 'check.cjs'));
  });

  it('does not follow a loader under another name, which is the stated limit (U11)', () => {
    const text = "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconsole.log(load('./h.cjs').v);\n";
    expect(moves({ 'check.mjs': text }, 'check.mjs', 'h.cjs')).toBe(false);
  });
});

describe('checker identity ignores text that is no import', () => {
  afterEach(cleanup);

  it.each<[name: string, entry: string, files: Files]>([
    ['an exported function whose first string is a workspace path (O1)', 'check.mjs', { 'check.mjs': "import { ok } from './lib.mjs';\nprocess.exit(ok() ? 0 : 1);\n", 'lib.mjs': "import * as fs from 'node:fs';\n\nexport function ok() {\n  return fs.existsSync('./lesson.txt');\n}\n" }],
    ['an exported path constant (O1b)', 'check.mjs', { 'check.mjs': "import { TARGET } from './lib.mjs';\nconsole.log(TARGET);\n", 'lib.mjs': "export const TARGET = '../CLAUDE.md';\n" }],
    ['a string that names a require call (O2)', 'check.mjs', { 'check.mjs': "import * as fs from 'node:fs';\nconst src = fs.existsSync('a.js') ? fs.readFileSync('a.js', 'utf8') : '';\nprocess.exit(src.includes(\"require('./legacy')\") ? 1 : 0);\n" }],
    ['a string that names a dynamic import (O2b)', 'check.mjs', { 'check.mjs': "const BAD = \"import('./legacy.mjs')\";\nprocess.exit(0);\n" }],
    ['an import inside a block comment (O3)', 'check.mjs', { 'check.mjs': "/*\nimport { old } from './old.mjs';\n*/\nprocess.exit(0);\n" }],
    ['an import line inside a template literal (O5)', 'check.mjs', { 'check.mjs': `const SAMPLE = ${TICK}\nimport legacy from './legacy.mjs';\n${TICK};\nprocess.exit(SAMPLE.length ? 0 : 1);\n` }],
    ['a line comment that names a require call (O7)', 'check.mjs', { 'check.mjs': "// The agent must not write require('./legacy') again.\nprocess.exit(0);\n" }],
    ['a require in a line comment of a .cjs', 'check.cjs', { 'check.cjs': "// was: require('./gone.cjs')\nconsole.log('ok');\n" }],
    ['a require in a string of a .cjs', 'check.cjs', { 'check.cjs': "const hint = \"use require('./gone.cjs') instead\";\nconsole.log('ok');\n" }],
    ['an import type in a JSDoc comment', 'check.mjs', { 'check.mjs': "/** @type {import('./types').Verdict} */\nconst verdict = 'pass';\nconsole.log(verdict);\n" }],
    ['a regular expression that holds an import call', 'check.mjs', { 'check.mjs': "const RE = /require\\('\\.\\/legacy'\\)|import\\(\"\\.\\/legacy\\.mjs\"\\)/;\nconsole.log(RE.test(''));\n" }],
  ])('%s', (_name, entry, files) => {
    expect(at(fresh(files), entry)).toBe(at(fresh(files), entry));
  });

  it('an exported path constant that names a real file leaves that file out (O4)', () => {
    const d = fresh({ 'check.mjs': "import { DOC } from './lib.mjs';\nconsole.log(DOC);\n", 'lib.mjs': "export const DOC = './README.md';\n", 'README.md': 'one\n' });
    const before = at(d);
    writeFileSync(join(d, 'README.md'), 'two\n');
    expect(at(d)).toBe(before);
  });
});

describe('checker identity stops the load on an import it cannot hash', () => {
  afterEach(cleanup);
  const CJS = body('h.cjs', 1);
  const ESM = body('h.mjs', 1);
  const OWN_NAME = /must be the file's own name/;

  it.each<[name: string, entry: string, files: Files, message: RegExp]>([
    ["require('..') (U5)", 'sub/check.cjs', { 'sub/check.cjs': "const { v } = require('..');\nconsole.log(v);\n", 'index.js': CJS }, /imports "\.\.".*must be the file's own name/],
    ["require('./') (U5b)", 'check.cjs', { 'check.cjs': "const { v } = require('./');\nconsole.log(v);\n", 'index.js': CJS }, /imports "\.\/".*must be the file's own name/],
    ["require('.') (U5c)", 'check.cjs', { 'check.cjs': "const { v } = require('.');\nconsole.log(v);\n", 'index.js': CJS }, /imports "\.".*must be the file's own name/],
    ['a folder (E1)', 'check.cjs', { 'check.cjs': "require('./lib');\n", 'lib/index.js': '// here\n' }, /imports "\.\/lib"/],
    ['a query string (E2)', 'check.mjs', { 'check.mjs': "import { v } from './h.mjs?v=1';\nconsole.log(v);\n", 'h.mjs': ESM }, /imports "\.\/h\.mjs\?v=1".*no query/],
    ['a backslash path (U7)', 'check.cjs', { 'check.cjs': "const { v } = require('.\\\\h.cjs');\nconsole.log(v);\n", 'h.cjs': CJS }, OWN_NAME],
    ['a percent escape, which import() decodes and require() does not', 'check.mjs', { 'check.mjs': "import { v } from './%68.mjs';\nconsole.log(v);\n", 'h.mjs': ESM, '%68.mjs': 'export const v = 99;\n' }, OWN_NAME],
    ['a fragment, which import() drops and require() keeps', 'check.mjs', { 'check.mjs': "import { v } from './h.mjs#x.mjs';\nconsole.log(v);\n", 'h.mjs': ESM, 'h.mjs#x.mjs': 'export const v = 99;\n' }, OWN_NAME],
    ['a computed import()', 'check.mjs', { 'check.mjs': "const name = 'h';\nconst m = await import('./' + name + '.mjs');\nconsole.log(m.v);\n", 'h.mjs': ESM }, /check\.mjs line 2: .*computed path/],
    ['a computed require()', 'check.cjs', { 'check.cjs': `const name = 'h';\n\nconst m = require(${TICK}./\${name}.cjs${TICK});\nconsole.log(m.v);\n`, 'h.cjs': CJS }, /check\.cjs line 3: .*computed path/],
    ['an absolute path', 'check.cjs', { 'check.cjs': "require('/nowhere/h.cjs');\n" }, /imports "\/nowhere\/h\.cjs".*absolute path, a URL/],
    ['a file: URL', 'check.mjs', { 'check.mjs': "import 'file:///nowhere/h.mjs';\n" }, /absolute path, a URL/],
    ['a data: URL, which can import a file: URL itself', 'check.mjs', { 'check.mjs': "import 'data:text/javascript,console.log(1)';\n" }, /absolute path, a URL/],
    ['a file: URL after a space, which a URL parser drops', 'check.mjs', { 'check.mjs': "import ' FILE:///nowhere/h.mjs';\n" }, /absolute path, a URL/],
    ['a drive letter with no slash, which require() reads from that drive', 'check.cjs', { 'check.cjs': "require('D:h.cjs');\n" }, /absolute path, a URL/],
    ['a package path that climbs back to a local file', 'check.cjs', { 'check.cjs': "console.log(require('x/../../h.cjs').v);\n", 'h.cjs': CJS }, /imports "x\/\.\.\/\.\.\/h\.cjs".*package path with "\.\."/],
    ['a trailing space, which import() drops and require() keeps', 'check.mjs', { 'check.mjs': "import { v } from './h.mjs ';\nconsole.log(v);\n", 'h.mjs': ESM }, OWN_NAME],
    ['an imported file with another extension, which CommonJS runs as code', 'check.cjs', { 'check.cjs': "console.log(require('./d.txt').v);\n", 'd.txt': "module.exports = require('./h.cjs');\n", 'h.cjs': CJS }, /imports "\.\/d\.txt".*must end in \.js, \.mjs, \.cjs, \.json or \.node/],
    ['an upper-case .JSON, which CommonJS runs as code', 'check.cjs', { 'check.cjs': "console.log(require('./d.JSON').v);\n", 'd.JSON': "module.exports = require('./h.cjs');\n", 'h.cjs': CJS }, /imports "\.\/d\.JSON".*lower case/],
    ['a .wasm file, which CommonJS runs as code', 'check.cjs', { 'check.cjs': "console.log(require('./d.wasm').v);\n", 'd.wasm': "module.exports = require('./h.cjs');\n", 'h.cjs': CJS }, /imports "\.\/d\.wasm"/],
    ['an .mjs helper named in upper case, which a file system that ignores case hands to CommonJS', 'check.cjs', { 'check.cjs': "console.log(require('./t.MJS').v);\n", 't.mjs': "var g = 1, x = 1; globalThis.await = 4;\nvar out = await /x; module.exports = require('./h.cjs'); var y = 1/g;\n", 'h.cjs': CJS }, /imports "\.\/t\.MJS"/],
    ['an entry that is not .js, .mjs or .cjs in lower case', 'check.MJS', { 'check.MJS': "console.log('ok');\n" }, /check\.MJS.*must end in \.js, \.mjs or \.cjs/],
    ['syntax the parser cannot read, which could hide an import', 'check.mjs', { 'check.mjs': "const one = 1;\nimport source w from './w.wasm';\nconsole.log(one, w);\n", 'w.wasm': 'x' }, /check\.mjs line 2: .*cannot parse/],
    ['an HTML comment in CommonJS, which the parser reads as code', 'check.cjs', { 'check.cjs': `var x = 1, y = 2;\nvar z = x <!--y ${TICK}\nconst { v } = require('./h.cjs'); // ${TICK}\nconsole.log(v, z);\n`, 'h.cjs': CJS }, /check\.cjs line 2: .*<!--/],
    ['an arrow in a case clause, which node runs and the parser reads as a typed arrow', 'check.cjs', { 'check.cjs': "var a = 1, b = 1;\nswitch (b) { case a ? (b) : (p) => q => p : lbl: console.log(require('./h.cjs').v); }\n", 'h.cjs': CJS }, /check\.cjs line 2: .*TypeScript type/],
    ['a package path that hides ".." behind a tab, which import() drops', 'sub/check.mjs', { 'sub/check.mjs': "import { v } from 'x/.\\t./.\\t./h.mjs';\nconsole.log(v);\n", 'sub/h.mjs': ESM, 'sub/node_modules/x/package.json': '{ "name": "x", "version": "1.0.0" }\n' }, /package path with "\.\."/],
    ['a package path that writes ".." as %2e, which import() decodes', 'check.mjs', { 'check.mjs': "import { v } from 'x/%2e%2e/%2E%2e/h.mjs';\nconsole.log(v);\n", 'h.mjs': ESM }, /imports "x\/%2e%2e\/%2E%2e\/h\.mjs".*package path with "\.\."/],
    ['an upper-case .MJS helper on disk', 'check.cjs', { 'check.cjs': "console.log(require('./u.MJS').v);\n", 'u.MJS': ESM }, /imports "\.\/u\.MJS".*lower case/],
    ['a top-level await before a regular expression that holds a quote, in an .mjs file', 'check.mjs', { 'check.mjs': "const r = await /\"/.test('x');\nconst { v } = await import('./h.mjs');\nconsole.log(v, r);\n", 'h.mjs': ESM }, /check\.mjs line 1: .*cannot parse/],
    ['a top-level await before a regular expression at a line end, in an .mjs file', 'check.mjs', { 'check.mjs': "const r = await /x/\nconst { v } = await import('./h.mjs');\nconsole.log(v, r);\n", 'h.mjs': ESM }, /check\.mjs line 2: .*cannot parse/],
    ['"<" right before a regular expression', 'check.cjs', { 'check.cjs': "var a = 1;\nvar ok = a</re/.test(String(require('./h.cjs').v));\nconsole.log(ok);\n", 'h.cjs': CJS }, /check\.cjs line 2: .*cannot parse/],
    ['"<" right before a line comment, in an .mjs file', 'check.mjs', { 'check.mjs': "const a = 1, b = 2;\nconst r = a <// why\n b;\nimport { v } from './h.mjs';\nconsole.log(v, r);\n", 'h.mjs': ESM }, /check\.mjs line 2: .*cannot parse/],
    ['a decimal number with a leading zero', 'check.cjs', { 'check.cjs': "var n = 08;\nconsole.log(require('./h.cjs').v, n);\n", 'h.cjs': CJS }, /check\.cjs line 1: .*cannot parse/],
    ['an arrow function in a nested conditional', 'check.cjs', { 'check.cjs': "var x = 1, y = 0, b = 2;\nvar f = x ? y ? (b) : c => require('./h.cjs').v : 0;\nconsole.log(f());\n", 'h.cjs': CJS }, /check\.cjs line 2: .*cannot parse/],
    ['a "-->" comment in CommonJS', 'check.cjs', { 'check.cjs': "var x = 1;\n--> require('./h.cjs')\nconsole.log(x);\n", 'h.cjs': CJS }, /check\.cjs line 2: .*cannot parse/],
  ])('stops on %s', (_name, entry, files, message) => {
    expect(() => at(fresh(files), entry)).toThrow(message);
  });
});

describe('checker identity names a parser it cannot use', () => {
  afterEach(cleanup);
  const MODULE = fileURLToPath(new URL('../scripts/token-eval/checker-identity.mjs', import.meta.url));
  /** A copy of the module beside a stub typescript package, so the copy loads the stub. */
  const withParser = async (stub: string) => {
    const d = fresh({
      'check.mjs': "console.log('ok');\n",
      'node_modules/typescript/package.json': '{ "name": "typescript", "main": "index.js" }\n',
      'node_modules/typescript/index.js': stub,
    });
    copyFileSync(MODULE, join(d, 'checker-identity.mjs'));
    const m = await import(/* @vite-ignore */ pathToFileURL(join(d, 'checker-identity.mjs')).href);
    return () => m.checkerFiles(join(d, 'check.mjs'));
  };

  it.each<[name: string, stub: string, message: RegExp]>([
    ['a typescript package that does not load', "throw Object.assign(new Error('no such module'), { code: 'MODULE_NOT_FOUND' });\n", /typescript package did not load \(MODULE_NOT_FOUND\).*npm install/],
    ['a typescript with no parser API', "module.exports = { version: '7.0.0' };\n", /installed typescript 7\.0\.0 does not have it/],
    ['a typescript 5.2, which has no JSDoc parsing mode', "module.exports = { version: '5.2.0', createSourceFile() {}, forEachChild() {}, ScriptTarget: { Latest: 99 } };\n", /installed typescript 5\.2\.0 does not have it/],
    ['a parser that reports no parse errors', "module.exports = { version: '5.9.0', createSourceFile: () => ({}), forEachChild() {}, ScriptTarget: { Latest: 99 }, JSDocParsingMode: { ParseNone: 1 } };\n", /does not report parse errors/],
  ])('stops on %s', async (_name, stub, message) => {
    expect(await withParser(stub)).toThrow(message);
  });
});
