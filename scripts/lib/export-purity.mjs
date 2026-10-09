// Rule K of the test-only export gate: an exported function or class is not a test seam when its own module calls it
// and, followed through its module and its imports, it reaches no I/O, no db-layer module and no module-level binding that any code writes.

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { analyze } from './module-facts.mjs';

const IO_BUILTIN = /^(node:)?(fs|child_process|sqlite|http|https|http2|net|dgram|tls|dns|os|cluster|worker_threads|module|readline|process)(\/.*)?$/;
const PURE_BUILTIN = /^(node:)?(path|url|crypto|util|buffer|events|assert|zlib|string_decoder|perf_hooks|timers|stream)(\/.*)?$/;
const CONTAINERS = /^(Map|Set|WeakMap|WeakSet|Array)$/;

const factsOf = (unit) => (unit.facts ??= analyze(unit.node));

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

function declareImport(decls, st) {
  const clause = st.importClause;
  if (!clause) return;
  const spec = st.moduleSpecifier.text;
  const typeOnly = !!clause.isTypeOnly;
  if (clause.name) decls.set(clause.name.text, { kind: 'import', spec, imported: 'default', typeOnly });
  const bound = clause.namedBindings;
  if (bound && ts.isNamespaceImport(bound)) decls.set(bound.name.text, { kind: 'import', spec, imported: '*', typeOnly });
  for (const el of (bound && ts.isNamedImports(bound) ? bound.elements : [])) {
    decls.set(el.name.text, { kind: 'import', spec, imported: (el.propertyName ?? el.name).text, typeOnly: typeOnly || !!el.isTypeOnly });
  }
}

function declareReExport(mod, st) {
  if (!st.moduleSpecifier) return;
  const spec = st.moduleSpecifier.text;
  const clause = st.exportClause;
  if (!clause) mod.stars.push(spec);
  else if (ts.isNamespaceExport(clause)) mod.decls.set(clause.name.text, { kind: 'import', spec, imported: '*', typeOnly: !!st.isTypeOnly });
  else for (const el of clause.elements) {
    if (!mod.decls.has(el.name.text)) mod.decls.set(el.name.text, { kind: 'import', spec, imported: (el.propertyName ?? el.name).text, typeOnly: !!st.isTypeOnly || !!el.isTypeOnly });
  }
}

function declareVariables(mod, st) {
  const kind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  for (const d of st.declarationList.declarations) {
    const unit = { node: d };
    mod.units.push(unit);
    for (const name of bindingNames(d.name)) mod.decls.set(name, { kind, node: d, unit });
  }
}

const KIND_OF = [[ts.isFunctionDeclaration, 'function'], [ts.isClassDeclaration, 'class'], [ts.isEnumDeclaration, 'enum'], [ts.isInterfaceDeclaration, 'type'], [ts.isTypeAliasDeclaration, 'type']];

function declare(mod, st) {
  if (ts.isImportDeclaration(st)) return declareImport(mod.decls, st);
  if (ts.isExportDeclaration(st)) return declareReExport(mod, st);
  if (ts.isExportAssignment(st)) return undefined;
  if (ts.isVariableStatement(st)) return declareVariables(mod, st);
  const unit = { node: st };
  mod.units.push(unit);
  const kind = KIND_OF.find(([is]) => is(st))?.[1];
  // A type may share its name with a value (`const X` plus `type X`); the value is the one that can hold state.
  if (kind && st.name && !(kind === 'type' && mod.decls.has(st.name.text))) mod.decls.set(st.name.text, { kind, node: st, unit });
  return undefined;
}

function parseModule(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const mod = { decls: new Map(), stars: [], units: [], written: new Set() };
  for (const st of sf.statements) declare(mod, st);
  return mod;
}

function resolveSpec(mods, from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.(js|ts)$/, '');
  return [`${base}.ts`, `${base}/index.ts`].find((p) => mods.has(p)) ?? null;
}

/** The module and name that really declare `name` as seen from `file`, through named and star re-exports. */
function resolveExport(mods, file, name, depth = 0) {
  const mod = mods.get(file);
  if (!mod || depth > 12) return null;
  const d = mod.decls.get(name);
  if (d && d.kind !== 'import') return { file, name };
  if (d) {
    const target = resolveSpec(mods, file, d.spec);
    return target && d.imported !== '*' && d.imported !== 'default' ? resolveExport(mods, target, d.imported, depth + 1) : null;
  }
  for (const spec of mod.stars) {
    const target = resolveSpec(mods, file, spec);
    const hit = target ? resolveExport(mods, target, name, depth + 1) : null;
    if (hit) return hit;
  }
  return null;
}

/** Records, on the declaring module, every module-level binding that any src code writes, in its own module or through an import. */
function markWrites(mods) {
  for (const [file, mod] of mods) {
    for (const w of mod.units.flatMap((u) => factsOf(u).writes)) {
      const d = mod.decls.get(w.name);
      if (!d) continue;
      if (d.kind !== 'import') { mod.written.add(w.name); continue; }
      const target = resolveSpec(mods, file, d.spec);
      const name = d.imported === '*' ? w.prop : d.imported;
      const at = target && name ? resolveExport(mods, target, name) : null;
      if (at) mods.get(at.file).written.add(at.name);
    }
  }
}

function isEmptyContainer(d) {
  const init = d.node.initializer;
  if (!init) return false;
  if (ts.isNewExpression(init)) return ts.isIdentifier(init.expression) && CONTAINERS.test(init.expression.text) && (init.arguments?.length ?? 0) === 0;
  return (ts.isArrayLiteralExpression(init) && init.elements.length === 0) || (ts.isObjectLiteralExpression(init) && init.properties.length === 0);
}

// The `let` keyword alone misses a const object or container that code writes to (a counter object, a cache map).
const isState = (mod, name, d) => d.kind === 'let' || mod.written.has(name) || (d.kind === 'const' && isEmptyContainer(d));

function layerReader(root) {
  const path = join(root, 'layers.json');
  const layers = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return (file) => {
    const parts = file.replace(/^src\//, '').split('/');
    return parts.length === 1 ? layers.rootFiles?.[parts[0]] : layers.folders?.[parts[0]];
  };
}

function importReason(mods, layerOf, file, d, follow) {
  const target = resolveSpec(mods, file, d.spec);
  if (!target) {
    if (IO_BUILTIN.test(d.spec)) return `imports ${d.spec}`;
    return PURE_BUILTIN.test(d.spec) ? null : `imports ${d.spec}, which is outside src/`;
  }
  if (layerOf(target) === 'db') return `db layer: ${target}`;
  if (d.imported === '*' || d.imported === 'default') return d.typeOnly ? null : `whole-module import of ${target}`;
  return follow(target, d.imported);
}

/** Returns `impure(file, name)`: null when the name is pure, else the first impure path found. */
function purityJudge(mods, layerOf) {
  const memo = new Map();
  const stack = [];
  let cut = Infinity;
  const judge = (file, name) => {
    const mod = mods.get(file);
    const d = mod.decls.get(name);
    if (!d) {
      const at = resolveExport(mods, file, name);
      return at ? impure(at.file, at.name) : null;
    }
    if (d.kind === 'import') return importReason(mods, layerOf, file, d, impure);
    if (d.kind === 'type' || d.kind === 'enum') return null;
    if (isState(mod, name, d)) return `module-level state ${name} in ${file}`;
    const facts = factsOf(d.unit);
    if (facts.globals.size > 0) return `${[...facts.globals][0]} in ${file}:${name}`;
    for (const used of facts.used) {
      const sub = impure(file, used);
      if (sub) return `${name} -> ${sub}`;
    }
    return null;
  };
  function impure(file, name) {
    const key = `${file}:${name}`;
    if (memo.has(key)) return memo.get(key);
    const depth = stack.indexOf(key);
    if (depth >= 0) { cut = Math.min(cut, depth); return null; }
    const outer = cut;
    cut = Infinity;
    stack.push(key);
    const reason = judge(file, name);
    stack.pop();
    // A pure verdict reached by cutting a cycle at a caller still on the stack waits for that caller's own verdict.
    const settled = reason !== null || cut >= stack.length;
    if (settled) memo.set(key, reason);
    cut = Math.min(outer, settled ? Infinity : cut);
    return reason;
  }
  return impure;
}

function isCallable(d) {
  if (d.kind === 'function' || d.kind === 'class') return true;
  const init = d.kind === 'const' ? d.node.initializer : undefined;
  return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/**
 * Builds the rule over the src files of a repo.
 * @param {string} root repo root; `layers.json` there names the db layer
 * @param {{ file: string, text: string }[]} srcFiles paths relative to the root, forward slashes
 * @returns {{ has: (file: string) => boolean, resolveExport: (file: string, name: string) => { file: string, name: string } | null, verdict: (file: string, name: string) => { exempt: boolean, why: string } }}
 */
export function createPurityRule(root, srcFiles) {
  const mods = new Map(srcFiles.map((f) => [f.file, parseModule(f.file, f.text)]));
  markWrites(mods);
  const impure = purityJudge(mods, layerReader(root));
  const verdict = (file, name) => {
    const mod = mods.get(file);
    const d = mod?.decls.get(name);
    if (!d || !isCallable(d)) return { exempt: false, why: 'not a function or class' };
    if (!mod.units.some((u) => u !== d.unit && factsOf(u).valueUsed.has(name))) return { exempt: false, why: 'no caller in its own module' };
    const reason = impure(file, name);
    return reason ? { exempt: false, why: reason } : { exempt: true, why: 'pure, and its own module calls it' };
  };
  return { has: (file) => mods.has(file), resolveExport: (file, name) => resolveExport(mods, file, name), verdict };
}
