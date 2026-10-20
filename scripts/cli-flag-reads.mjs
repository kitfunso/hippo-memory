#!/usr/bin/env node
// Per-verb flag reads: for each row of the verb table in src/surface/cli/verbs/, the flags its handler and every function it hands the flags object to read.
// It follows the object, so a flags object built elsewhere does not count toward a verb. Usage: cli-flag-reads.mjs [--json]

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARRAY_CALLBACKS = new Set(['map', 'filter', 'some', 'every', 'find', 'forEach', 'flatMap']);
const VALUE_CALLS = new Set(['String', 'Number', 'parseInt', 'parseFloat', 'Array.isArray']);
// Object.keys is left out: it lists names, as a validator does, and reads no value.
const WHOLE_OBJECT_CALLS = new Set(['Object.entries', 'Object.values', 'JSON.stringify', 'Object.assign']);
const EQUALITY = new Set(['===', '!==', '==', '!=']);
const KIND_RANK = ['value', 'unknown', 'on-off', 'presence'];

/** One kind for several uses: any value use wins, and an unclassed use hides an on/off one. */
function mergeKinds(kinds) {
  const seen = kinds.map((kind) => (kind === 'returned' ? 'unknown' : kind)).filter((kind) => kind !== 'write');
  return KIND_RANK.find((kind) => seen.includes(kind)) ?? 'unknown';
}

function loadEnv(repo) {
  // Loaded from this script's install, so a fixture tree without node_modules can be walked.
  const ts = createRequire(import.meta.url)('typescript');
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(repo, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  return {
    ts,
    repo,
    program,
    checker: program.getTypeChecker(),
    unfollowed: [],
    memo: new Map(),
    inProgress: new Set(),
  };
}

function where(env, node) {
  const sf = node.getSourceFile();
  const file = path.relative(env.repo, sf.fileName).replace(/\\/g, '/');
  return `${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function lineText(node) {
  const sf = node.getSourceFile();
  return sf.text.split('\n')[sf.getLineAndCharacterOfPosition(node.getStart()).line].trim().slice(0, 160);
}

function strip(ts, expr) {
  let cur = expr;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isFunctionLike(ts, node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

function enclosingFunction(ts, node) {
  let cur = node.parent;
  while (cur && !isFunctionLike(ts, cur)) cur = cur.parent;
  return cur ?? node.getSourceFile();
}

function literalKeys(env, expr) {
  const { ts, checker } = env;
  const e = strip(ts, expr);
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isArrayLiteralExpression(e)) {
    const parts = e.elements.map((el) => literalKeys(env, ts.isSpreadElement(el) ? el.expression : el));
    return parts.includes(null) ? null : parts.flat();
  }
  if (ts.isNewExpression(e) && e.expression.getText() === 'Set' && e.arguments?.length === 1) {
    return literalKeys(env, e.arguments[0]);
  }
  if (ts.isIdentifier(e)) {
    const decl = checker.getSymbolAtLocation(e)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && decl !== e.parent) {
      return literalKeys(env, decl.initializer);
    }
  }
  return null;
}

/** The values a key identifier takes as a loop variable or an array-callback parameter over literals. */
function loopKeys(env, ident) {
  const { ts, checker } = env;
  const decl = checker.getSymbolAtLocation(ident)?.valueDeclaration;
  if (!decl) return null;
  if (
    ts.isVariableDeclaration(decl) &&
    ts.isVariableDeclarationList(decl.parent) &&
    ts.isForOfStatement(decl.parent.parent)
  ) {
    return literalKeys(env, decl.parent.parent.expression);
  }
  const call = ts.isParameter(decl) && isFunctionLike(ts, decl.parent) ? decl.parent.parent : null;
  if (
    call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ARRAY_CALLBACKS.has(call.expression.name.text)
  ) {
    return literalKeys(env, call.expression.expression);
  }
  return null;
}

function functionOf(env, expr) {
  const { ts, checker } = env;
  const e = strip(ts, expr);
  if (isFunctionLike(ts, e)) return e;
  if (!ts.isIdentifier(e)) return null;
  let sym = ts.isShorthandPropertyAssignment(e.parent)
    ? checker.getShorthandAssignmentValueSymbol(e.parent)
    : checker.getSymbolAtLocation(e);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  if (decl && isFunctionLike(ts, decl)) return decl;
  const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? strip(ts, decl.initializer) : null;
  return init && isFunctionLike(ts, init) ? init : null;
}

/** `TABLE[key](...)` over a const object of functions calls any one of them, so all of them count. */
function tableHandlers(env, call) {
  const { ts, checker } = env;
  const callee = strip(ts, call.expression);
  if (!ts.isElementAccessExpression(callee) || !ts.isIdentifier(strip(ts, callee.expression))) return null;
  const decl = checker.getSymbolAtLocation(strip(ts, callee.expression))?.valueDeclaration;
  const table = decl && ts.isVariableDeclaration(decl) && decl.initializer ? strip(ts, decl.initializer) : null;
  if (!table || !ts.isObjectLiteralExpression(table)) return null;
  return table.properties.map((prop) =>
    ts.isPropertyAssignment(prop)
      ? functionOf(env, prop.initializer)
      : ts.isShorthandPropertyAssignment(prop)
        ? functionOf(env, prop.name)
        : null,
  );
}

function usesOf(env, nameNode, scope, depth) {
  const { ts, checker } = env;
  const sym = checker.getSymbolAtLocation(nameNode);
  const kinds = [];
  const walk = (n) => {
    if (ts.isIdentifier(n) && n !== nameNode && checker.getSymbolAtLocation(n) === sym) {
      kinds.push(useKind(env, n, depth + 1));
    }
    ts.forEachChild(n, walk);
  };
  if (sym && scope) walk(scope);
  return kinds;
}

function argumentKind(env, call, arg, depth) {
  const { ts, checker } = env;
  const name = call.expression.getText();
  if (name === 'Boolean') return 'on-off';
  if (VALUE_CALLS.has(name)) return 'value';
  const decl = depth < 2 ? checker.getResolvedSignature(call)?.declaration : undefined;
  const param =
    decl && isFunctionLike(ts, decl) && decl.body ? decl.parameters[call.arguments.indexOf(arg)] : undefined;
  return param && ts.isIdentifier(param.name) ? mergeKinds(usesOf(env, param.name, decl.body, depth)) : 'unknown';
}

function operandKind(ts, binary, operand) {
  const op = binary.operatorToken.getText();
  const other = binary.left === operand ? binary.right : binary.left;
  if (EQUALITY.has(op)) {
    const text = other.getText();
    if (text === 'true' || text === 'false') return 'on-off';
    if (text === 'undefined') return 'presence';
    return ts.isStringLiteral(other) ? 'value' : 'unknown';
  }
  // `flag || 'default'` takes the flag's value; `flag || other.setting` only asks whether it is on.
  const literal =
    ts.isStringLiteralLike(other) ||
    ts.isNumericLiteral(other) ||
    ts.isTemplateExpression(other) ||
    other.kind === ts.SyntaxKind.NullKeyword ||
    other.getText() === 'undefined';
  if (op === '||') return binary.left === operand && literal ? 'value' : 'on-off';
  if (op === '&&') return 'on-off';
  if (op === '??') return 'value';
  return op === '=' && binary.left === operand ? 'write' : 'unknown';
}

/** How one occurrence of a flag's value is used: on-off, value, presence, write, returned or unknown. */
function useKind(env, node, depth = 0) {
  const { ts } = env;
  let cur = node;
  let p = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p))) {
    cur = p;
    p = p.parent;
  }
  if (!p) return 'unknown';
  if (ts.isAsExpression(p)) {
    return /string|number/.test(p.type.getText()) ? 'value' : p.type.getText() === 'boolean' ? 'on-off' : 'unknown';
  }
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return 'on-off';
  if (ts.isTypeOfExpression(p) || ts.isTemplateSpan(p)) return 'value';
  if (ts.isCallExpression(p) && p.arguments.includes(cur)) return argumentKind(env, p, cur, depth);
  if (ts.isBinaryExpression(p)) return operandKind(ts, p, cur);
  if (ts.isIfStatement(p) && p.expression === cur) return 'on-off';
  if (ts.isConditionalExpression(p)) return p.condition === cur ? 'on-off' : 'value';
  if (ts.isPropertyAccessExpression(p) && p.expression === cur) return 'value';
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && depth < 2) {
    return mergeKinds(usesOf(env, p.name, enclosingFunction(ts, p), depth));
  }
  return ts.isReturnStatement(p) || ts.isArrowFunction(p) ? 'returned' : 'unknown';
}

function noteUnfollowed(env, node, why) {
  env.unfollowed.push(`${where(env, node)}  ${why}: ${lineText(node)}`);
}

/** Binds a name as the flags object ('flags') or a context holding it ('ctx'); a `{ flags }` pattern unpacks a context. */
function bind(env, scope, name, kind) {
  const { ts, checker } = env;
  const target = ts.isIdentifier(name)
    ? name
    : kind === 'ctx' && ts.isObjectBindingPattern(name)
      ? name.elements.find((el) => (el.propertyName ?? el.name).getText() === 'flags' && ts.isIdentifier(el.name))?.name
      : undefined;
  const sym = target ? checker.getSymbolAtLocation(target) : undefined;
  if (sym) scope[ts.isIdentifier(name) ? kind : 'flags'].add(sym);
}

// A member a known object literal lacks: a call through it never runs for that object.
const ABSENT = Symbol('absent');

/** The object literal a `const` name is declared as, so a config passed by name is followed like one written inline. */
function constObject(env, ident) {
  const { ts, checker } = env;
  let sym = checker.getSymbolAtLocation(ident);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null;
  if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
  const init = strip(ts, decl.initializer);
  return ts.isObjectLiteralExpression(init) ? init : null;
}

/** The property `obj.name` picks from a known object literal: ABSENT when the literal surely lacks it, null when unknown. */
function memberOf(env, scope, access, depth) {
  const { ts } = env;
  const base = valueOf(env, scope, access.expression, depth + 1);
  if (base === ABSENT) return ABSENT;
  if (!base || !ts.isObjectLiteralExpression(base)) return null;
  const prop = base.properties.find((p) => p.name?.getText() === access.name.text);
  // A spread may carry the member, so only a literal without one surely lacks it.
  return prop ?? (base.properties.some((p) => ts.isSpreadAssignment(p)) ? null : ABSENT);
}

/** The function or object literal an expression names, through bound names, declarations and factory calls; null when unknown. */
function valueOf(env, scope, expr, depth = 0) {
  const { ts, checker } = env;
  const e = strip(ts, expr);
  if (!e || depth > 6) return null;
  if (isFunctionLike(ts, e) || ts.isObjectLiteralExpression(e)) return e;
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    return (sym && scope?.bound.get(sym)) ?? functionOf(env, e) ?? constObject(env, e);
  }
  if (ts.isPropertyAccessExpression(e)) {
    const prop = memberOf(env, scope, e, depth);
    if (!prop || prop === ABSENT) return prop;
    if (ts.isMethodDeclaration(prop)) return prop;
    if (ts.isShorthandPropertyAssignment(prop)) return functionOf(env, prop.name);
    return ts.isPropertyAssignment(prop) ? valueOf(env, null, prop.initializer, depth + 1) : null;
  }
  if (!ts.isCallExpression(e)) return null;
  const fn = valueOf(env, scope, e.expression, depth + 1);
  if (!fn || fn === ABSENT || !isFunctionLike(ts, fn) || !fn.body) return null;
  const ret = ts.isBlock(fn.body)
    ? fn.body.statements.find((s) => ts.isReturnStatement(s) && s.expression)?.expression
    : fn.body;
  return ret ? valueOf(env, null, ret, depth + 1) : null;
}

/** The callee's parameters bound to the functions and object literals a call passes it. */
function boundParams(env, scope, decl, callArgs) {
  const { ts, checker } = env;
  const bound = new Map();
  decl.parameters.forEach((param, index) => {
    const value = callArgs[index] && ts.isIdentifier(param.name) ? valueOf(env, scope, callArgs[index]) : null;
    const sym = value && value !== ABSENT ? checker.getSymbolAtLocation(param.name) : undefined;
    if (sym) bound.set(sym, value);
  });
  return bound;
}

function newScope(env, fn, taint, bound) {
  const scope = {
    flags: new Set(),
    ctx: new Set(),
    paramIndex: new Map(),
    bound: new Map(bound),
    reads: [],
    keyParams: new Map(),
  };
  fn.parameters.forEach((param, index) => {
    const sym = env.ts.isIdentifier(param.name) ? env.checker.getSymbolAtLocation(param.name) : undefined;
    if (sym) scope.paramIndex.set(sym, index);
    if (taint.has(index)) bind(env, scope, param.name, taint.get(index));
  });
  return scope;
}

function taintOf(env, scope, expr) {
  const { ts, checker } = env;
  const e = strip(ts, expr);
  if (!e) return null;
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    return sym && scope.flags.has(sym) ? 'flags' : sym && scope.ctx.has(sym) ? 'ctx' : null;
  }
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'flags' && taintOf(env, scope, e.expression) === 'ctx') {
    return 'flags';
  }
  if (!ts.isObjectLiteralExpression(e)) return null;
  for (const prop of e.properties) {
    if (ts.isSpreadAssignment(prop) && taintOf(env, scope, prop.expression)) {
      return taintOf(env, scope, prop.expression);
    }
    const shorthand =
      ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'flags'
        ? checker.getShorthandAssignmentValueSymbol(prop)
        : undefined;
    if (shorthand && scope.flags.has(shorthand)) return 'ctx';
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name.getText() === 'flags' &&
      taintOf(env, scope, prop.initializer) === 'flags'
    ) {
      return 'ctx';
    }
  }
  return null;
}

/** Records a read under each literal key; a key that is one of the function's own parameters is left for its callers to name. */
function addRead(env, scope, keyExpr, node, kind) {
  const { ts, checker } = env;
  const ident = strip(ts, keyExpr);
  const sym = ts.isIdentifier(ident) ? checker.getSymbolAtLocation(ident) : undefined;
  if (sym && scope.paramIndex.has(sym)) {
    const index = scope.paramIndex.get(sym);
    scope.keyParams.set(index, [...(scope.keyParams.get(index) ?? []), kind]);
    return;
  }
  const keys = keysOf(env, scope, ident);
  if (!keys) noteUnfollowed(env, node, 'computed key');
  for (const key of keys ?? []) scope.reads.push({ key, kind, at: where(env, node), text: lineText(node) });
}

/** The names a key takes: a literal, a loop over literals, or a member of a known config; none for a member it lacks. */
function keysOf(env, scope, key) {
  const { ts } = env;
  if (ts.isIdentifier(key)) return loopKeys(env, key) ?? literalKeys(env, key);
  if (!ts.isPropertyAccessExpression(key)) return literalKeys(env, key);
  const member = memberOf(env, scope, key, 0);
  if (member === ABSENT) return [];
  return member && ts.isPropertyAssignment(member) ? literalKeys(env, member.initializer) : null;
}

function followCall(env, scope, call) {
  const { ts, checker } = env;
  const callArgs = call.arguments ?? [];
  const tainted = new Map();
  callArgs.forEach((arg, index) => {
    if (taintOf(env, scope, arg)) tainted.set(index, taintOf(env, scope, arg));
  });
  const name = call.expression.getText();
  if (tainted.size === 0 || name === 'Object.keys') return;
  if (name === 'Object.hasOwn' && callArgs.length === 2) {
    addRead(env, scope, callArgs[1], call, 'presence');
    return;
  }
  if (WHOLE_OBJECT_CALLS.has(name)) {
    noteUnfollowed(env, call, 'whole object');
    return;
  }
  const target = valueOf(env, scope, call.expression);
  if (target === ABSENT) return;
  const decls = tableHandlers(env, call) ?? [
    target && isFunctionLike(ts, target) ? target : checker.getResolvedSignature(call)?.declaration,
  ];
  if (decls.some((d) => !d || !isFunctionLike(ts, d) || !d.body || d.getSourceFile().isDeclarationFile)) {
    noteUnfollowed(env, call, 'call not followed');
    return;
  }
  for (const decl of decls) {
    const callee = analyze(env, decl, tainted, boundParams(env, scope, decl, callArgs));
    scope.reads.push(...callee.reads);
    for (const [index, kinds] of callee.keyParams) {
      if (!callArgs[index]) noteUnfollowed(env, call, 'missing key argument');
      // A helper that hands the value back is classed by what its caller does with it.
      else {
        for (const kind of kinds) {
          addRead(env, scope, callArgs[index], call, kind === 'returned' ? useKind(env, call) : kind);
        }
      }
    }
  }
}

function visitDeclaration(env, scope, node) {
  const { ts } = env;
  const value = ts.isIdentifier(node.name) ? valueOf(env, scope, node.initializer) : null;
  const sym = value && value !== ABSENT ? env.checker.getSymbolAtLocation(node.name) : undefined;
  if (sym) scope.bound.set(sym, value);
  const kind = taintOf(env, scope, node.initializer);
  if (!kind) return;
  if (kind === 'ctx' || ts.isIdentifier(node.name)) {
    bind(env, scope, node.name, kind);
    return;
  }
  for (const el of node.name.elements ?? []) {
    const key = (el.propertyName ?? el.name).getText().replace(/['"]/g, '');
    const uses = usesOf(env, el.name, enclosingFunction(ts, node), 0);
    scope.reads.push({ key, kind: mergeKinds(uses), at: where(env, el), text: lineText(el) });
  }
}

function visitNode(env, scope, node) {
  const { ts } = env;
  const onFlags = (expr) => taintOf(env, scope, expr) === 'flags';
  if (ts.isVariableDeclaration(node) && node.initializer) visitDeclaration(env, scope, node);
  if (ts.isElementAccessExpression(node) && onFlags(node.expression)) {
    const kind = useKind(env, node);
    if (kind !== 'write') addRead(env, scope, node.argumentExpression, node, kind);
  } else if (ts.isPropertyAccessExpression(node) && onFlags(node.expression)) {
    scope.reads.push({ key: node.name.text, kind: useKind(env, node), at: where(env, node), text: lineText(node) });
  } else if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    onFlags(node.right)
  ) {
    addRead(env, scope, node.left, node, 'presence');
  } else if ((ts.isForInStatement(node) || ts.isSpreadAssignment(node)) && onFlags(node.expression)) {
    noteUnfollowed(env, node, 'whole object');
  } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    followCall(env, scope, node);
  }
  ts.forEachChild(node, (child) => visitNode(env, scope, child));
}

/** One function's reads, given which parameters (by index) are the flags object or a context holding it. */
function analyze(env, fn, taint, bound = new Map()) {
  const boundKey = [...bound]
    .map(([sym, value]) => `${sym.valueDeclaration?.pos}=${value.pos}:${value.getSourceFile().fileName}`)
    .sort();
  const memoKey = `${fn.pos}:${fn.getSourceFile().fileName}:${[...taint].sort().join(',')}:${boundKey.join(',')}`;
  if (env.memo.has(memoKey)) return env.memo.get(memoKey);
  if (env.inProgress.has(memoKey)) return { reads: [], keyParams: new Map() };
  env.inProgress.add(memoKey);
  const scope = newScope(env, fn, taint, bound);
  if (fn.body) visitNode(env, scope, fn.body);
  env.memo.set(memoKey, scope);
  env.inProgress.delete(memoKey);
  return scope;
}

/** The function a `verb(() => import(module), 'handleX', row)` row names, export handleX of that module; a `factory(descriptor)` export runs what the factory returns. */
function rowHandler(env, call) {
  const { ts, checker } = env;
  const [load, name] = call.arguments;
  let loaded = null;
  const find = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) loaded = node.arguments[0];
    else ts.forEachChild(node, find);
  };
  find(load);
  const moduleSym = loaded ? checker.getSymbolAtLocation(loaded) : undefined;
  let sym =
    moduleSym && ts.isStringLiteral(name) ? checker.tryGetMemberInModuleExports(name.text, moduleSym) : undefined;
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? strip(ts, decl.initializer) : null;
  const fn = decl && isFunctionLike(ts, decl) ? decl : init && isFunctionLike(ts, init) ? init : null;
  if (fn) return { run: fn, bound: new Map() };
  const factory = init && ts.isCallExpression(init) ? valueOf(env, null, init.expression) : null;
  const made = factory && factory !== ABSENT && isFunctionLike(ts, factory) ? valueOf(env, null, init) : null;
  if (!made || made === ABSENT || !isFunctionLike(ts, made)) {
    throw new Error(`verb row handler not found: ${where(env, call)}`);
  }
  return { run: made, bound: boundParams(env, null, factory, init.arguments) };
}

/** The handler of every `verb(...)` row of the verb table in src/surface/cli/verbs/. */
function commandRows(env) {
  const { ts, program, repo } = env;
  const verbsDir = path.resolve(repo, 'src', 'surface', 'cli', 'verbs');
  const rows = [];
  const find = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText() === 'verb'
    ) {
      rows.push({
        verb: ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(),
        ...rowHandler(env, node.initializer),
      });
    }
    ts.forEachChild(node, find);
  };
  for (const sf of program.getSourceFiles()) if (path.dirname(path.resolve(sf.fileName)) === verbsDir) find(sf);
  if (rows.length === 0) throw new Error('no verb rows found in src/surface/cli/verbs/');
  return rows;
}

/** @returns {{ verbs: { verb: string, flags: Record<string, string> }[], unfollowed: string[], unclassed: string[] }} each read classed on-off, value, presence or unknown. */
export function collectVerbReads(repo = '.') {
  const env = loadEnv(path.resolve(repo));
  const unclassed = [];
  const verbs = commandRows(env).map(({ verb, run, bound }) => {
    const byKey = new Map();
    for (const read of analyze(env, run, new Map([[0, 'ctx']]), bound).reads) {
      byKey.set(read.key, [...(byKey.get(read.key) ?? []), read]);
    }
    const flags = {};
    for (const key of [...byKey.keys()].sort()) {
      flags[key] = mergeKinds(byKey.get(key).map((read) => read.kind));
      if (flags[key] !== 'unknown') continue;
      for (const read of byKey.get(key)) {
        if (mergeKinds([read.kind]) === 'unknown') unclassed.push(`${verb} --${key}  ${read.at}  ${read.text}`);
      }
    }
    return { verb, flags };
  });
  return { verbs, unfollowed: [...new Set(env.unfollowed)], unclassed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = collectVerbReads(process.cwd());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(found, null, 1));
  } else {
    for (const { verb, flags } of found.verbs) {
      console.log(
        `${verb}: ${
          Object.entries(flags)
            .map(([key, kind]) => `${key}(${kind})`)
            .join(' ') || '-'
        }`,
      );
    }
    for (const line of found.unfollowed) console.log(`unfollowed  ${line}`);
    for (const line of found.unclassed) console.log(`unclassed  ${line}`);
  }
}
