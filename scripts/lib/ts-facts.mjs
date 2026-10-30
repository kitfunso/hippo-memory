// One TypeScript parse per file for the check scripts: imports, strings and dist/ imports.
// No program and no type checker, so a gate reads syntax only and a comment or string never counts as code.

import ts from 'typescript';

const LOCAL_SPEC = /^\.\.?\//;
const DIST_SPEC = /(?:^|\/)dist\//;

/** True for a relative specifier, the only kind that names a file inside the tree. */
export const isLocalSpec = (spec) => LOCAL_SPEC.test(spec);

const bindingName = (el) => (el.propertyName ?? el.name).text;

function importFact(node, line) {
  const clause = node.importClause;
  if (!clause) {
    return {
      spec: node.moduleSpecifier.text,
      line,
      kind: 'side-effect',
      typeOnly: false,
      names: ['*'],
      hasDefault: false,
      specifiers: [],
    };
  }
  const bindings = clause.namedBindings;
  const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
  // tsc erases the statement when every named specifier is `type X` and nothing else is bound.
  const allTypes = !clause.name && named.length > 0 && named.every((e) => e.isTypeOnly);
  const names = named.map((e) => bindingName(e));
  if (clause.name || (bindings && ts.isNamespaceImport(bindings))) names.push('*');
  return {
    spec: node.moduleSpecifier.text,
    line,
    kind: 'import',
    typeOnly: clause.isTypeOnly || allTypes,
    names,
    hasDefault: Boolean(clause.name),
    specifiers: named.map((e) => ({ name: bindingName(e), typeOnly: clause.isTypeOnly || e.isTypeOnly })),
  };
}

function exportFact(node, line) {
  const clause = node.exportClause;
  const named = clause && ts.isNamedExports(clause) ? clause.elements : null;
  const allTypes = named !== null && named.length > 0 && named.every((e) => e.isTypeOnly);
  return {
    spec: node.moduleSpecifier.text,
    line,
    kind: 'export',
    typeOnly: node.isTypeOnly || allTypes,
    names: named ? named.map(bindingName) : ['*'],
    hasDefault: false,
    specifiers: (named ?? []).map((e) => ({ name: bindingName(e), typeOnly: node.isTypeOnly || e.isTypeOnly })),
  };
}

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
 * Every dist/ import at any depth: static imports and re-exports, `import(...)` and `distImport('x')`. Code in a string
 * or comment is not parsed, so a fixture written as text never counts.
 */
function readDistImports(sourceFile, facts, lineOf) {
  const visit = (node) => {
    const isStatic = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
    const spec =
      isStatic && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
    if (DIST_SPEC.test(spec) && !erased(node)) {
      facts.distImports.push({ line: lineOf(node), spec, fromRepo: false, names: valueNames(node) });
    }
    const dynamic = dynamicImport(node);
    if (dynamic) facts.distImports.push({ line: lineOf(node), ...dynamic, names: boundNames(node) });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const ALL = ['imports', 'strings'];

/** Static imports and re-exports sit at the top level, so no tree walk is needed for them. */
function readTopLevel(sourceFile, facts, lineOf) {
  for (const n of sourceFile.statements) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      facts.imports.push(importFact(n, lineOf(n)));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      facts.imports.push(exportFact(n, lineOf(n)));
    }
  }
}

/** Every string and template piece, at any depth. */
function readStrings(sourceFile, facts, lineOf) {
  const visit = (n) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      facts.strings.push({ text: n.text, line: lineOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
}

/**
 * Parses a source once and lists the facts named in `wanted`; the others stay empty and cost nothing. Lines are 1-based.
 * `imports` is the top-level import and export-from statements; `distImports` is every dist/ import, asked by name.
 * A gate that looks for one token should skip the call when the raw text lacks it.
 * @param {string} text
 * @param {string} [fileName] decides the script kind, so pass the real name for `.tsx` or `.mjs`
 * @param {readonly string[]} [wanted] any of imports, strings and distImports; default imports and strings
 * @returns {{
 *   sourceFile: ts.SourceFile,
 *   imports: { spec: string, line: number, kind: 'import' | 'export' | 'side-effect', typeOnly: boolean, names: string[], hasDefault: boolean, specifiers: { name: string, typeOnly: boolean }[] }[],
 *   strings: { text: string, line: number }[],
 *   distImports: DistImport[],
 * }}
 */
export function readFacts(text, fileName = 'file.ts', wanted = ALL) {
  const want = new Set(wanted);
  // Only the dist/ reader needs parent pointers (an `await import()` binding), and they cost a second pass.
  const dist = want.has('distImports') && text.includes('dist');
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, dist);
  const facts = { sourceFile, imports: [], strings: [], distImports: [] };
  const lineOf = (n) => sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
  if (want.has('imports')) readTopLevel(sourceFile, facts, lineOf);
  if (want.has('strings')) readStrings(sourceFile, facts, lineOf);
  if (dist) readDistImports(sourceFile, facts, lineOf);
  return facts;
}

/** The relative specifiers a source loads at startup: type-only imports are erased, and no `import()` is read. */
export function runtimeSpecifiers(text) {
  return readFacts(text, 'file.ts', ['imports'])
    .imports.filter((i) => !i.typeOnly && isLocalSpec(i.spec))
    .map((i) => i.spec);
}
