// One TypeScript parse per file for the check scripts: imports and strings.
// No program and no type checker, so a gate reads syntax only and a comment or string never counts as code.

import ts from 'typescript';

const LOCAL_SPEC = /^\.\.?\//;

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
 * `imports` is the top-level import and export-from statements. A gate that looks for one token should skip the call
 * when the raw text lacks it.
 * @param {string} text
 * @param {string} [fileName] decides the script kind, so pass the real name for `.tsx` or `.mjs`
 * @param {readonly string[]} [wanted] imports, strings or both; default both
 * @returns {{
 *   sourceFile: ts.SourceFile,
 *   imports: { spec: string, line: number, kind: 'import' | 'export' | 'side-effect', typeOnly: boolean, names: string[], hasDefault: boolean, specifiers: { name: string, typeOnly: boolean }[] }[],
 *   strings: { text: string, line: number }[],
 * }}
 */
export function readFacts(text, fileName = 'file.ts', wanted = ALL) {
  // No parent pointers: no fact needs them, and setting them costs a second pass over every node.
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const facts = { sourceFile, imports: [], strings: [] };
  const want = new Set(wanted);
  const lineOf = (n) => sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
  if (want.has('imports')) readTopLevel(sourceFile, facts, lineOf);
  if (want.has('strings')) readStrings(sourceFile, facts, lineOf);
  return facts;
}

/** The relative specifiers a source loads at startup: type-only imports are erased, and no `import()` is read. */
export function runtimeSpecifiers(text) {
  return readFacts(text, 'file.ts', ['imports'])
    .imports.filter((i) => !i.typeOnly && isLocalSpec(i.spec))
    .map((i) => i.spec);
}
