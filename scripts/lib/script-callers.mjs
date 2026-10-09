// Callers outside src/ for the test-only export gate: a file under scripts/ or benchmarks/ that imports a src module,
// by its dist/ build path or its src/ path, is a production caller of the names it uses from that module.

import { posix } from 'node:path';
import ts from 'typescript';

const JS_PATH = /^[\w./-]+\.js$/;

/** The src module behind an import specifier written in `from`, or null when it does not land in the repo's dist/ or src/. */
function toSrc(has, from, spec) {
  if (!spec.startsWith('.')) return null;
  const m = /^(?:dist|src)\/(.+)\.(?:js|mjs|ts)$/.exec(posix.normalize(posix.join(posix.dirname(from), spec)));
  return m && has(`src/${m[1]}.ts`) ? `src/${m[1]}.ts` : null;
}

/** The src module a path literal names when the file builds its import path at run time (`load('store/open.js')`). */
function fromLiteral(has, text) {
  if (!JS_PATH.test(text)) return null;
  const file = `src/${text.replace(/^.*(?:^|\/)(?:dist|src)\//, '').replace(/^\.\//, '').replace(/\.js$/, '.ts')}`;
  return has(file) ? file : null;
}

function readStatic(found, st, resolve) {
  if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier) return;
  const target = resolve(st.moduleSpecifier.text);
  const clause = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : st.exportClause;
  if (!target || !clause || st.importClause?.isTypeOnly || st.isTypeOnly) return;
  if (ts.isNamespaceImport(clause)) found.spaces.set(clause.name.text, target);
  else if (!ts.isNamespaceExport(clause)) for (const el of clause.elements) if (!el.isTypeOnly) found.named.push([target, (el.propertyName ?? el.name).text]);
}

function readCall(found, call, resolve) {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = call.arguments[0];
    const literal = arg && ts.isStringLiteralLike(arg);
    const target = literal ? resolve(arg.text) : null;
    if (target) found.loose.add(target);
    else if (!literal) found.computed = true;
    return;
  }
  // `join(REPO, 'dist', 'store', 'open.js')` names one path, so its pieces are never read as paths of their own.
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      found.literals.add(run.map((a) => a.text).join('/'));
      for (const a of run) found.joined.add(a);
    }
    run = [];
  };
  for (const a of call.arguments) {
    if (ts.isStringLiteralLike(a)) run.push(a);
    else flush();
  }
  flush();
}

function scan(file, text, has) {
  const kind = /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found = { named: [], spaces: new Map(), loose: new Set(), literals: new Set(), joined: new Set(), ids: new Set(), computed: false };
  const resolve = (spec) => toSrc(has, file, spec);
  for (const st of sf.statements) readStatic(found, st, resolve);
  const visit = (n) => {
    if (ts.isIdentifier(n)) found.ids.add(n.text);
    else if (ts.isStringLiteralLike(n)) { if (!found.joined.has(n)) found.literals.add(n.text); }
    else if (ts.isCallExpression(n)) readCall(found, n, resolve);
    else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && found.spaces.has(n.expression.text)) found.named.push([found.spaces.get(n.expression.text), n.name.text]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (found.computed) for (const text of found.literals) found.loose.add(fromLiteral(has, text));
  found.loose.delete(null);
  return found;
}

/**
 * Every `src/file.ts:NAME` that a script or benchmark imports and uses. A dynamic `import()` lists no names,
 * so that file counts for every identifier it holds that the imported module declares.
 * @param {{ file: string, text: string }[]} files paths relative to the repo root, forward slashes
 * @param {(file: string) => boolean} has true for a src module path
 * @param {(file: string, name: string) => { file: string, name: string } | null} resolveExport follows re-exports to the declaring module
 * @returns {Set<string>}
 */
export function scriptCallers(files, has, resolveExport) {
  const callers = new Set();
  const add = (target, name) => {
    const at = resolveExport(target, name);
    if (at) callers.add(`${at.file}:${at.name}`);
  };
  for (const f of files) {
    if (!/dist|src\//.test(f.text)) continue;
    const found = scan(f.file, f.text, has);
    for (const [target, name] of found.named) add(target, name);
    for (const target of found.loose) for (const id of found.ids) add(target, id);
  }
  return callers;
}
