#!/usr/bin/env node
// Fails when a script, benchmark, eval or test imports a dist/ file the build no longer makes, or a value that file no
// longer exports: module moves broke such imports twice, and only the one shard that ran them noticed. Run after build.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const SCANNED = ['scripts', 'benchmarks', 'evals', 'tests'];

/** `<file> -> <specifier>` keys of imports left broken on purpose, each with why. Keep it empty: fix the import. */
export const ALLOWED = {};

const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const TS_SOURCE = /\.(?:ts|mts|cts)$/;
const DIST_SPEC = /(?:^|\/)dist\//;

/**
 * @typedef {{ line: number, spec: string, fromRepo: boolean, names: string[] }} DistImport
 * `fromRepo` specs resolve against the repo root, the rest against the importing file's folder.
 */

/** True when tsc drops the statement: `import type`, `export type`, or every named specifier marked `type`. */
function erased(node) {
  const clause = ts.isImportDeclaration(node) ? node.importClause : node;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const named = ts.isImportDeclaration(node) ? clause.namedBindings : node.exportClause;
  const elements = named && (ts.isNamedImports(named) || ts.isNamedExports(named)) ? named.elements : [];
  return !clause.name && elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

/** The names a static import or re-export takes as values: type-only ones are erased, `* as` checks no name. */
function valueNames(node) {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly || !node.exportClause || !ts.isNamedExports(node.exportClause)) return [];
    return node.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
  }
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return [];
  const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
  const names = named.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text);
  return clause.name ? ['default', ...names] : names;
}

/** `pathToFileURL(x)`, `pathToFileURL(x).href` and `new URL(x, import.meta.url)` load what `x` names. */
function unwrapUrl(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') return unwrapUrl(node.expression);
  const call = ts.isCallExpression(node) || ts.isNewExpression(node) ? node : null;
  const callee = call && ts.isIdentifier(call.expression) ? call.expression.text : '';
  if ((callee === 'pathToFileURL' || callee === 'URL') && call.arguments?.length) return unwrapUrl(call.arguments[0]);
  return node;
}

/** A literal path, or `path.join(root, 'dist', ...)` and `join(DIST, ...)` with literal parts after the root. */
function targetOf(arg) {
  const node = unwrapUrl(arg);
  if (ts.isStringLiteralLike(node)) return DIST_SPEC.test(node.text) ? { spec: node.text, fromRepo: false } : null;
  if (!ts.isCallExpression(node) || !/^(?:path\.)?(?:join|resolve)$/.test(node.expression.getText())) return null;
  const [first, ...rest] = node.arguments;
  if (!first || !rest.every(ts.isStringLiteralLike)) return null;
  const parts = rest.map((part) => part.text);
  if (ts.isIdentifier(first) && first.text === 'DIST') return { spec: ['dist', ...parts].join('/'), fromRepo: true };
  const at = parts.indexOf('dist');
  return at < 0 ? null : { spec: parts.slice(at).join('/'), fromRepo: true };
}

/** The value names `const { a, b: c } = await import(...)` takes; any other use checks only that the file loads. */
function boundNames(call) {
  let node = call.parent;
  if (node && ts.isAwaitExpression(node)) node = node.parent;
  if (!node || !ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return [];
  return node.name.elements
    .filter((e) => !e.dotDotDotToken)
    .map((e) => e.propertyName ?? e.name)
    .filter((n) => ts.isIdentifier(n) || ts.isStringLiteral(n))
    .map((n) => n.text);
}

/** `import(...)` and `distImport('x')` calls that name a dist/ file. */
function dynamicImport(node) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return targetOf(node.arguments[0]);
  const arg = node.arguments[0];
  const isDistImport = ts.isIdentifier(node.expression) && node.expression.text === 'distImport';
  return isDistImport && ts.isStringLiteralLike(arg) ? { spec: `dist/${arg.text}`, fromRepo: true } : null;
}

/**
 * Every dist/ import in one source: static imports and re-exports, `import(...)` and `distImport('x')`. Code in a
 * string or comment is not parsed, so a fixture written as text never counts.
 * @param {string} text
 * @param {string} fileName
 * @returns {DistImport[]}
 */
export function distImports(text, fileName) {
  if (!text.includes('dist')) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const found = [];
  const visit = (node) => {
    const isStatic = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
    if (isStatic && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !erased(node)) {
      const spec = node.moduleSpecifier.text;
      if (DIST_SPEC.test(spec)) found.push({ line: lineOf(node), spec, fromRepo: false, names: valueNames(node) });
    }
    const dynamic = dynamicImport(node);
    if (dynamic) found.push({ line: lineOf(node), ...dynamic, names: boundNames(node) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function listSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : listSources(path);
    return SOURCE.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Exports of each declaration file that carry no value, so a TypeScript import of one without `type` is no miss. */
function typeOnlyExports(dtsFiles) {
  const program = ts.createProgram(dtsFiles, { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  return new Map(
    dtsFiles.map((file) => {
      const source = program.getSourceFile(file);
      const module = source && checker.getSymbolAtLocation(source);
      const exports = module ? checker.getExportsOfModule(module) : [];
      const valueless = exports.filter((e) => {
        const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        return !(target.flags & ts.SymbolFlags.Value);
      });
      return [file, new Set(valueless.map((e) => e.name))];
    }),
  );
}

/** Loads each dist/ target once; a missing file or a load error is the target's whole result. */
async function loadTargets(targets) {
  const loaded = new Map();
  for (const target of targets) {
    if (!existsSync(target)) {
      loaded.set(target, { error: 'is not built' });
      continue;
    }
    try {
      loaded.set(target, { mod: await import(pathToFileURL(target).href) });
    } catch (err) {
      loaded.set(target, { error: `does not load (${err.code ?? err.message})` });
    }
  }
  return loaded;
}

/** Each import's target inside the repo's dist/, or none for a fixture's own dist folder. */
function withTargets(repo, files) {
  const dist = resolve(repo, 'dist') + sep;
  return files.flatMap((file) => {
    const rel = relative(repo, file).replace(/\\/g, '/');
    return distImports(readFileSync(file, 'utf8'), file).flatMap((imp) => {
      const target = resolve(imp.fromRepo ? repo : dirname(file), imp.spec);
      return target.startsWith(dist) ? [{ file: rel, isTs: TS_SOURCE.test(file), target, ...imp }] : [];
    });
  });
}

/**
 * Every dist/ import under `roots` of `repo` that does not load, or lacks a value it names, less the allowed ones.
 * @param {string} repo
 * @param {{ roots?: readonly string[], allowed?: Record<string, string> }} [opts]
 * @returns {Promise<{ checked: number, problems: { file: string, line: number, spec: string, problem: string }[] }>}
 */
export async function checkDistImports(repo, { roots = SCANNED, allowed = ALLOWED } = {}) {
  const imports = withTargets(
    repo,
    roots.flatMap((root) => listSources(join(repo, root))),
  );
  const loaded = await loadTargets(new Set(imports.map((imp) => imp.target)));
  const missing = imports.map((imp) => {
    const mod = loaded.get(imp.target).mod ?? {};
    return { imp, gone: imp.names.filter((n) => !(n in mod)) };
  });
  const dts = (target) => target.slice(0, -extname(target).length) + '.d.ts';
  const typed = missing.filter(({ imp, gone }) => imp.isTs && gone.length > 0 && existsSync(dts(imp.target)));
  const types = typed.length > 0 ? typeOnlyExports([...new Set(typed.map(({ imp }) => dts(imp.target)))]) : new Map();
  const problems = missing.flatMap(({ imp, gone }) => {
    const { error } = loaded.get(imp.target);
    const values = gone.filter((n) => !types.get(dts(imp.target))?.has(n));
    const problem = error ?? (values.length > 0 ? `lacks ${values.join(', ')}` : null);
    if (!problem || Object.hasOwn(allowed, `${imp.file} -> ${imp.spec}`)) return [];
    return [{ file: imp.file, line: imp.line, spec: imp.spec, problem }];
  });
  problems.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return { checked: imports.length, problems };
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = resolve(process.argv[2] ?? '.');
  if (!existsSync(join(repo, 'dist', 'index.js'))) {
    console.error('dist/index.js is missing: run `npm run build` first.');
    process.exit(1);
  }
  const { checked, problems } = await checkDistImports(repo);
  if (problems.length > 0) {
    console.error(`\ndist/ imports in ${SCANNED.join(', ')} that the build no longer serves:`);
    for (const p of problems) console.error(`  ${p.file}:${p.line} -> ${p.spec}: ${p.problem}`);
    console.error('\nFix: point the import at the file that exports the name now, often dist/index.js.\n');
    process.exit(1);
  }
  console.log(`${checked} dist/ imports in ${SCANNED.join(', ')} load, with every value they name. OK.`);
}
