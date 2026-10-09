// Facts about one top-level declaration for the test-only export gate: the outer names it reads, the outer names it writes, and the I/O globals it touches.
// A name bound by an enclosing function or class of the use is local, so a parameter that shares a module-level name is not a read of it.

import ts from 'typescript';

const K = ts.SyntaxKind;
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const OBJECT_WRITERS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
// These calls hand back a value the receiver still holds, so a write through the result is a write to the receiver.
const PASS_THROUGH = new Set(['get', 'at', 'find']);
const PROCESS_STATE = /^(env|cwd|chdir|argv|exit|exitCode|stdout|stderr|stdin|kill|on|once|pid)$/;
const IO_GLOBALS = new Set(['fetch', 'console', 'globalThis', 'require']);

const isScope = (n) => ts.isFunctionLike(n) || ts.isClassLike(n);
const hasOwnName = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassLike(n);

/** Names a function, class or top-level declaration binds itself; nested functions and classes keep theirs. */
function boundIn(scope) {
  const names = new Set();
  if (hasOwnName(scope) && scope.name) names.add(scope.name.text);
  const visit = (n) => {
    const binds = ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isTypeParameterDeclaration(n);
    const declares = ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n);
    if ((binds || declares) && n.name && ts.isIdentifier(n.name)) names.add(n.name.text);
    if (!isScope(n)) ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return names;
}

/** False for an identifier that names a property, a label or a declaration instead of reading a binding. */
function isReference(id) {
  const p = id.parent;
  if (p.name === id) return ts.isShorthandPropertyAssignment(p);
  if (p.propertyName === id || p.label === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  return !ts.isImportTypeNode(p);
}

/** True inside a type; `class A extends B` runs B, so that one heritage clause is a value position. */
function isTypePosition(n) {
  if (!ts.isTypeNode(n)) return false;
  if (!ts.isExpressionWithTypeArguments(n)) return true;
  const clause = n.parent;
  return ts.isHeritageClause(clause) && (clause.token === K.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent));
}

/** The expressions a node writes to: assignment targets, `++`/`--` operands, `delete` operands and receivers of mutating calls. */
function writeTargets(n) {
  if (ts.isBinaryExpression(n) && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment) return [n.left];
  if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) return [n.operand];
  if (ts.isDeleteExpression(n)) return [n.expression];
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return [];
  const receiver = n.expression.expression;
  if (MUTATORS.has(n.expression.name.text)) return [receiver];
  const onObject = ts.isIdentifier(receiver) && (receiver.text === 'Object' || receiver.text === 'Reflect');
  return onObject && OBJECT_WRITERS.has(n.expression.name.text) && n.arguments[0] ? [n.arguments[0]] : [];
}

/** Splits a destructuring target (`[a, b.c] = ...`, `({ x: d.e } = ...)`) into the single expressions it writes. */
function leaves(e) {
  if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((x) => leaves(ts.isSpreadElement(x) ? x.expression : x));
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? leaves(p.initializer) : ts.isSpreadAssignment(p) ? leaves(p.expression) : ts.isShorthandPropertyAssignment(p) ? [p.name] : []));
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.EqualsToken) return leaves(e.left);
  return [e];
}

/** The binding a written expression hangs off (`a.b[0].c` is `a`), with the property read straight off it. */
function rootOf(expression) {
  let e = expression;
  let prop = null;
  for (;;) {
    if (ts.isIdentifier(e)) return { name: e.text, prop };
    if (ts.isPropertyAccessExpression(e)) prop = e.name.text;
    else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && PASS_THROUGH.has(e.expression.name.text)) { e = e.expression; prop = null; }
    else if (ts.isElementAccessExpression(e)) prop = null;
    else if (!(ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) return null;
    e = e.expression;
  }
}

function noteRead(facts, id, inType) {
  facts.used.add(id.text);
  if (inType) return;
  facts.valueUsed.add(id.text);
  if (IO_GLOBALS.has(id.text)) facts.globals.add(id.text);
  if (id.text !== 'process') return;
  const p = id.parent;
  const prop = ts.isPropertyAccessExpression(p) && p.expression === id ? p.name.text : '*';
  if (prop === '*' || PROCESS_STATE.test(prop)) facts.globals.add(`process.${prop}`);
}

/**
 * Reads one top-level declaration or statement.
 * @param {ts.Node} root
 * @returns {{ used: Set<string>, valueUsed: Set<string>, globals: Set<string>, writes: { name: string, prop: string | null }[] }}
 *   `used` holds every outer name, `valueUsed` the ones read outside a type.
 */
export function analyze(root) {
  const facts = { used: new Set(), valueUsed: new Set(), globals: new Set(), writes: [] };
  const scopes = [boundIn(root)];
  const free = (name) => !scopes.some((s) => s.has(name));
  const visit = (n, inType) => {
    const opens = n !== root && isScope(n);
    if (opens) scopes.push(boundIn(n));
    if (ts.isIdentifier(n)) {
      if (isReference(n) && free(n.text)) noteRead(facts, n, inType);
    } else {
      if (ts.isCallExpression(n) && n.expression.kind === K.ImportKeyword) facts.globals.add('import()');
      for (const e of writeTargets(n).flatMap(leaves)) {
        const at = rootOf(e);
        if (at && free(at.name)) facts.writes.push(at);
      }
    }
    const typed = inType || isTypePosition(n);
    ts.forEachChild(n, (c) => visit(c, typed));
    if (opens) scopes.pop();
  };
  visit(root, false);
  return facts;
}
