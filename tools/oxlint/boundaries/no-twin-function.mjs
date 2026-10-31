// Plain JS with JSDoc types so the plugin loads on the package's Node floor, which cannot strip types.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { defineRule } from '@oxlint/plugins';

const TWIN = /(?:ThroughStore|OnHippoDb|UnderStore|OnStore)$/;
const SOURCE = /(?<!\.d)\.[cm]?ts$/;
// The formatter starts every top-level export at column 0, so the anchor skips nothing a file exports.
const EXPORT_NAME = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var)\s*([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\}(?!\s*from\b)/gm;
// The parser loads on the first name two files share, so most lint workers never load it.
const require = createRequire(import.meta.url);
/** @type {Map<string, Map<string, Set<string>>>} src folder -> name a file may export -> those files */
const indexes = new Map();
/** @type {Map<string, Set<string>>} file path -> the function names it really exports */
const parsed = new Map();

const slash = (p) => p.split(sep).join('/');

/** Every name `text` may export a function under: a cheap superset that exportedFunctions confirms. */
function exportNames(text) {
  const names = new Set([...text.matchAll(EXPORT_NAME)].map((m) => m[1]));
  for (const m of text.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, '');
      if (name) names.add(name);
    }
  }
  return names;
}

function isFunctionValue(ts, expr) {
  let e = expr;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) {
    e = e.expression;
  }
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
}

/** Top-level functions by local name: a declaration, or a const bound to an arrow or function expression. */
function localFunctions(ts, sf) {
  const found = new Map();
  const add = (name, node, exported) => {
    if (!found.has(name)) found.set(name, { at: sf.getLineAndCharacterOfPosition(node.getStart(sf)), exported });
  };
  const exported = (node) => !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt.name.text, stmt, exported(stmt));
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && isFunctionValue(ts, d.initializer)) add(d.name.text, d, exported(stmt));
    }
  }
  return found;
}

/** The functions `text` defines and exports, by exported name; a binding of another function is none. */
function exportedFunctions(file, text) {
  const ts = require('typescript');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const locals = localFunctions(ts, sf);
  const out = new Map([...locals].filter(([, f]) => f.exported).map(([name, f]) => [name, f.at]));
  for (const stmt of sf.statements) {
    const clause = ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier ? stmt.exportClause : undefined;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const el of clause.elements) {
      const local = locals.get((el.propertyName ?? el.name).text);
      if (local && !out.has(el.name.text)) out.set(el.name.text, local.at);
    }
  }
  return out;
}

function definesFunction(path, name) {
  if (!parsed.has(path)) parsed.set(path, new Set(exportedFunctions(path, readFileSync(path, 'utf8')).keys()));
  return parsed.get(path).has(name);
}

function indexOf(srcDir) {
  if (indexes.has(srcDir)) return indexes.get(srcDir);
  const index = new Map();
  for (const e of readdirSync(srcDir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !SOURCE.test(e.name)) continue;
    const path = join(e.parentPath, e.name);
    for (const name of exportNames(readFileSync(path, 'utf8'))) {
      index.set(name, (index.get(name) ?? new Set()).add(slash(relative(srcDir, path))));
    }
  }
  indexes.set(srcDir, index);
  return index;
}

/** Bars a second form of one function: one named for the store it runs on, or one exported under a name another
 * src file exports, which auto-import and code search then confuse. */
export const noTwinFunctionRule = defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow twin functions: named for their store, or exported twice under one name.' },
    messages: {
      twin: '"{{name}}" is a twin named for its store; keep one function that takes the store.',
      sameName: '"{{name}}" is also an exported function in src/{{other}}; rename the internal one.',
    },
  },
  createOnce(context) {
    /** @param {import('@oxlint/plugins').ESTree.Function} node */
    const check = (node) => {
      if (node.id && TWIN.test(node.id.name)) {
        context.report({ node, messageId: 'twin', data: { name: node.id.name } });
      }
    };
    const checkSameName = () => {
      const srcDir = join(context.cwd, 'src');
      const file = slash(relative(srcDir, context.physicalFilename));
      if (file.startsWith('../') || isAbsolute(file) || !SOURCE.test(file)) return;
      const index = indexOf(srcDir);
      const text = context.sourceCode.text;
      let own;
      for (const name of exportNames(text)) {
        const others = [...(index.get(name) ?? [])].filter((f) => f !== file);
        if (others.length === 0) continue;
        own ??= exportedFunctions(file, text);
        const other = own.has(name) && others.find((f) => definesFunction(join(srcDir, f), name));
        if (other) {
          const loc = { line: own.get(name).line + 1, column: own.get(name).character };
          context.report({ loc, messageId: 'sameName', data: { name, other } });
        }
      }
    };
    return { FunctionDeclaration: check, TSDeclareFunction: check, Program: checkSameName };
  },
});
