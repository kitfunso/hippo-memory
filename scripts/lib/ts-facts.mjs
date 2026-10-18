// One TypeScript parse per file for the check scripts: imports, calls, process.env reads, exported functions, strings and identifiers.
// No program and no type checker, so a gate reads syntax only and a comment or string never counts as code.

import ts from 'typescript';

const K = ts.SyntaxKind;
const LOCAL_SPEC = /^\.\.?\//;

/** True for the `.ts`, `.mts` and `.cts` sources; `.d.ts` files are declarations and no gate reads them. */
export const isTsSource = (name) => /\.(?:ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts');

/** True for a relative specifier, the only kind that names a file inside the tree. */
export const isLocalSpec = (spec) => LOCAL_SPEC.test(spec);

/** `loadConfig`, `process.exit` or `process.env` for a callee or receiver, whatever the spacing, `?.` or `["exit"]` spelling; else null. */
export function nameOf(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = nameOf(node.expression);
    return base === null ? null : `${base}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const base = nameOf(node.expression);
    return base === null ? null : `${base}.${node.argumentExpression.text}`;
  }
  return null;
}

const bindingName = (el) => (el.propertyName ?? el.name).text;
const hasModifier = (node, kind) =>
  (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);

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

/** `process.env` in code: a member access, `process["env"]`, or `{ env } = process` as a declaration or an assignment. */
function isProcessEnvRead(node) {
  const isProcess = (e) => nameOf(e)?.split('.').at(-1) === 'process';
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return nameOf(node)?.endsWith('process.env') === true && isProcess(node.expression);
  }
  const pattern = ts.isVariableDeclaration(node)
    ? node.name
    : ts.isBinaryExpression(node) && node.operatorToken.kind === K.EqualsToken
      ? node.left
      : null;
  const source = ts.isVariableDeclaration(node) ? node.initializer : ts.isBinaryExpression(node) ? node.right : null;
  if (!pattern || !source || !isProcess(source)) return false;
  if (ts.isObjectBindingPattern(pattern)) return pattern.elements.some((e) => bindingName(e) === 'env');
  return (
    ts.isObjectLiteralExpression(pattern) &&
    pattern.properties.some(
      (p) => p.name?.text === 'env' || (ts.isShorthandPropertyAssignment(p) && p.name.text === 'env'),
    )
  );
}

const ALL = ['imports', 'dynamic', 'calls', 'envReads', 'exportedFunctions', 'strings', 'identifiers'];
const DYNAMIC_IMPORT = /\bimport\s*\(/;
const WALKED = ['calls', 'envReads', 'strings', 'identifiers'];

/** Static imports, re-exports and exported functions sit at the top level, so no tree walk is needed for them. */
function readTopLevel(sourceFile, want, facts, lineOf) {
  for (const n of sourceFile.statements) {
    if (want.has('imports') && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      facts.imports.push(importFact(n, lineOf(n)));
    } else if (
      want.has('imports') &&
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      facts.imports.push(exportFact(n, lineOf(n)));
    } else if (
      want.has('exportedFunctions') &&
      ts.isFunctionDeclaration(n) &&
      n.name &&
      hasModifier(n, K.ExportKeyword)
    ) {
      const first = n.parameters[0]?.name;
      facts.exportedFunctions.push({
        name: n.name.text,
        firstParam: first && ts.isIdentifier(first) ? first.text : null,
      });
    }
  }
}

/** One walk for the facts that can sit at any depth; `calls` also carries the dynamic `import('x')` with a literal. */
function readDeep(sourceFile, want, facts, lineOf) {
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0];
      if (n.expression.kind === K.ImportKeyword) {
        if (want.has('dynamic') && arg && ts.isStringLiteralLike(arg)) {
          facts.imports.push({
            spec: arg.text,
            line: lineOf(n),
            kind: 'dynamic',
            typeOnly: false,
            names: ['*'],
            hasDefault: false,
            specifiers: [],
          });
        }
      } else if (want.has('calls')) {
        const callee = nameOf(n.expression);
        if (callee) facts.calls.push({ callee, line: lineOf(n) });
      }
    } else if (
      want.has('strings') &&
      (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
    ) {
      facts.strings.push({ text: n.text, line: lineOf(n) });
    } else if (want.has('identifiers') && ts.isIdentifier(n)) facts.identifiers.push({ name: n.text, line: lineOf(n) });
    if (want.has('envReads') && isProcessEnvRead(n)) facts.envReads.push({ line: lineOf(n) });
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
}

/**
 * Parses a source once and lists the facts named in `wanted`; the others stay empty and cost nothing. Lines are 1-based.
 * `imports` is the top-level import and export-from statements, `dynamic` adds `import('x')` with a literal, `exportedFunctions` the
 * top-level `export function` declarations. A gate that looks for one token should skip the call when the raw text lacks it.
 * @param {string} text
 * @param {string} [fileName] decides the script kind, so pass the real name for `.tsx` or `.mjs`
 * @param {readonly string[]} [wanted] any of imports, dynamic, calls, envReads, exportedFunctions, strings, identifiers; default all
 * @returns {{
 *   sourceFile: ts.SourceFile,
 *   imports: { spec: string, line: number, kind: 'import' | 'export' | 'side-effect' | 'dynamic', typeOnly: boolean, names: string[], hasDefault: boolean, specifiers: { name: string, typeOnly: boolean }[] }[],
 *   calls: { callee: string, line: number }[],
 *   envReads: { line: number }[],
 *   exportedFunctions: { name: string, firstParam: string | null }[],
 *   strings: { text: string, line: number }[],
 *   identifiers: { name: string, line: number }[],
 * }}
 */
export function readFacts(text, fileName = 'file.ts', wanted = ALL) {
  // No parent pointers: no fact needs them, and setting them costs a second pass over every node.
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const facts = {
    sourceFile,
    imports: [],
    calls: [],
    envReads: [],
    exportedFunctions: [],
    strings: [],
    identifiers: [],
  };
  const want = new Set(wanted);
  const lineOf = (n) => sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
  readTopLevel(sourceFile, want, facts, lineOf);
  // A dynamic import() cannot exist without its text, so a file that lacks it needs no walk for it.
  if (WALKED.some((k) => want.has(k)) || (want.has('dynamic') && DYNAMIC_IMPORT.test(text))) {
    readDeep(sourceFile, want, facts, lineOf);
  }
  return facts;
}

/** The relative specifiers a source loads at startup: type-only imports are erased and a dynamic `import()` is lazy. */
export function runtimeSpecifiers(text) {
  return readFacts(text, 'file.ts', ['imports'])
    .imports.filter((i) => !i.typeOnly && isLocalSpec(i.spec))
    .map((i) => i.spec);
}
