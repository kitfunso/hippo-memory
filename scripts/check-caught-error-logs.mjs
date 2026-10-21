#!/usr/bin/env node
// Per-file count of log calls inside a catch block, a `.catch` callback, an 'error' event listener or a function taking
// the caught error as a parameter that omit errorFields() may fall, never rise, so an operator reading the log sees the error class and stack of every failure.
// A call that reads one field of errorFields(...) fails anywhere in src, with no baseline: it drops the rest.
// A catch that only pushes the error's text into a result array, with no log call carrying errorFields(...), fails the same way.
// Usage: check-caught-error-logs.mjs [--update]. --update rewrites the baseline and refuses to raise a number.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { stripComments } from './lib/source-text.mjs';

const BASELINE = '.caught-error-logs-baseline.json';
const LOGGERS = new Set(['log', 'logger']);
const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'addEventListener']);

const isLogCall = (n) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  ts.isIdentifier(n.expression.expression) &&
  LOGGERS.has(n.expression.expression.text);

const isErrorFieldsCall = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'errorFields';

// errorClassFields keeps the class and errno but not the text or stack, for a line that must not carry caller data.
const isErrorClassFieldsCall = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'errorClassFields';

/** True for `errorFields(x).errorClass`, `errorFields(x)['errorClass']` and `const { errorClass } = errorFields(x)`. */
function readsOneField(call) {
  const p = call.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === call) return true;
  return ts.isVariableDeclaration(p) && p.initializer === call && ts.isObjectBindingPattern(p.name);
}

// expectedErrorText (src/base/util/log.ts) names an error the caller classified as expected.
const isExpectedErrorTextCall = (n) =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'expectedErrorText';

/** True when some node under `call` passes `match`. */
function contains(call, match) {
  let found = false;
  const visit = (n) => {
    if (match(n)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(call);
  return found;
}

/** True when the call hands the whole errorFields(...) result on; `errorFields(x).errorClass` drops the stack and cause. */
const carriesErrorFields = (call) =>
  contains(call, (n) => (isErrorFieldsCall(n) || isErrorClassFieldsCall(n)) && !readsOneField(n));

/** True for a `debug` line carrying expectedErrorText(...): an expected error earns that one line with no stack. */
const isExpectedDebugLine = (call) => call.expression.name.text === 'debug' && contains(call, isExpectedErrorTextCall);

const isFunction = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** Every function in the file by name, so `server.once('error', onError)` is read through its `const onError = ...`. */
function namedFunctions(sf) {
  const byName = new Map();
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) byName.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFunction(n.initializer)) {
      byName.set(n.name.text, n.initializer.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return byName;
}

/** The listener of `x.on('error', fn)`, `x.once('error', fn)` or `addEventListener('error', fn)`, inline or by name. */
function errorListenerBodies(node, functions) {
  const callee = node.expression;
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  const [event, listener] = node.arguments;
  if (!LISTENER_METHODS.has(method) || !event || !ts.isStringLiteralLike(event) || event.text !== 'error') return [];
  if (listener && isFunction(listener)) return [listener.body];
  const named = listener && ts.isIdentifier(listener) ? functions.get(listener.text) : undefined;
  return named ? [named] : [];
}

const ERROR_PARAM = /^(?:err|error|e|[a-z]\w*(?:Err|Error))$/;

/** The body of a function that takes a caught error as a parameter, such as `reportFailure(step, err)`. */
function errorParamBody(node) {
  const fn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || isFunction(node);
  if (!fn || !node.body) return [];
  return node.parameters.some((p) => ts.isIdentifier(p.name) && ERROR_PARAM.test(p.name.text)) ? [node.body] : [];
}

/** The bodies a node hands to the failure path: a catch block, a `.catch(...)` callback, an 'error' listener or a
 * function that takes the error as a parameter. */
function failureBodies(node, functions) {
  if (ts.isCatchClause(node)) return [node.block];
  const withParam = errorParamBody(node);
  if (withParam.length > 0) return withParam;
  if (!ts.isCallExpression(node)) return [];
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') {
    return node.arguments.filter(isFunction).map((a) => a.body);
  }
  return errorListenerBodies(node, functions);
}

/**
 * Returns the 1-based line of every log call inside a failure path that does not hand on errorFields(...) whole.
 * @param {string} text
 * @returns {number[]}
 */
export function unfieldedLogLines(text) {
  const sf = ts.createSourceFile('x.ts', stripComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = new Map();
  const functions = namedFunctions(sf);
  const collect = (node) => {
    if (isLogCall(node) && !carriesErrorFields(node) && !isExpectedDebugLine(node)) {
      hits.set(node.getStart(sf), sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node) => {
    for (const body of failureBodies(node, functions)) collect(body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits.values()].sort((a, b) => a - b);
}

/**
 * Returns the 1-based line of every errorFields(...) call whose result is read for one field.
 * @param {string} text
 * @returns {number[]}
 */
export function partialPickLines(text) {
  if (!text.includes('errorFields')) return [];
  const sf = ts.createSourceFile('x.ts', stripComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = [];
  const visit = (node) => {
    if (isErrorFieldsCall(node) && readsOneField(node)) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

const APPEND_METHODS = new Set(['push', 'unshift', 'append']);

const isNamed = (n, name) => ts.isIdentifier(n) && n.text === name;

/** True when `root` turns the caught error into text: errorMessage(e), String(e), e.message or a `${e}` span. */
const usesErrorText = (root, name) =>
  contains(
    root,
    (n) =>
      (ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        (n.expression.text === 'errorMessage' || n.expression.text === 'String') &&
        n.arguments.some((a) => isNamed(a, name))) ||
      (ts.isPropertyAccessExpression(n) && n.name.text === 'message' && isNamed(n.expression, name)) ||
      (ts.isTemplateSpan(n) && isNamed(n.expression, name)),
  );

/**
 * Returns the 1-based line of every catch whose error only reaches an array push or append, with no log call in the same
 * catch that hands on errorFields(...).
 * @param {string} text
 * @returns {number[]}
 */
export function resultOnlyCatchLines(text) {
  const sf = ts.createSourceFile('x.ts', stripComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = [];
  const visit = (node) => {
    const name =
      ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)
        ? node.variableDeclaration.name.text
        : null;
    if (name !== null) {
      const pushesError = contains(
        node.block,
        (n) =>
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          APPEND_METHODS.has(n.expression.name.text) &&
          n.arguments.some((a) => usesErrorText(a, name)),
      );
      const logsFields = contains(node.block, (n) => isLogCall(n) && carriesErrorFields(n));
      if (pushesError && !logsFields) lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|mts|cts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Counts the unfielded log calls in each file under srcDir; files with none are left out.
 * @param {string} srcDir
 * @returns {Record<string, number>} path relative to srcDir, with forward slashes, to count
 */
export function countUnfieldedLogs(srcDir) {
  const root = resolve(srcDir);
  const counts = {};
  for (const p of listSourceFiles(root).sort()) {
    const n = unfieldedLogLines(readFileSync(p, 'utf8')).length;
    if (n > 0) counts[relative(root, p).replace(/\\/g, '/')] = n;
  }
  return counts;
}

/**
 * Lists `path:line` for every partial errorFields pick under srcDir.
 * @param {string} srcDir
 * @returns {string[]}
 */
export function findPartialPicks(srcDir) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .sort()
    .flatMap((p) =>
      partialPickLines(readFileSync(p, 'utf8')).map((line) => `${relative(root, p).replace(/\\/g, '/')}:${line}`),
    );
}

/**
 * Lists `path:line` for every catch that records its error only in a result array.
 * @param {string} srcDir
 * @returns {string[]}
 */
export function findResultOnlyCatches(srcDir) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .sort()
    .flatMap((p) =>
      resultOnlyCatchLines(readFileSync(p, 'utf8')).map((line) => `${relative(root, p).replace(/\\/g, '/')}:${line}`),
    );
}

/** The committed counts, or none when the file is absent; one read, so no exists-then-read race. */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counts = Object.fromEntries(Object.entries(countUnfieldedLogs('src')).map(([f, n]) => [`src/${f}`, n]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const base = readBaseline();
  const picks = findPartialPicks('src');
  if (picks.length > 0) {
    for (const where of picks) console.error(`src/${where}: reads one field of errorFields(...) and drops the rest`);
    console.error('Fix: hand errorFields(err) on whole, or use errorClassFields(err) where the text must stay out.');
    process.exit(1);
  }
  const resultOnly = findResultOnlyCatches('src');
  if (resultOnly.length > 0) {
    for (const where of resultOnly) {
      console.error(`src/${where}: the caught error goes only into a result array, not a log`);
    }
    console.error('Fix: log it with errorFields(err) in the same catch, then keep the result line.');
    process.exit(1);
  }
  const risen = Object.entries(counts).filter(([f, n]) => n > (base[f] ?? 0));
  if (process.argv.includes('--update')) {
    if (risen.length > 0) {
      console.error('refusing to raise a number:', risen.map(([f]) => f).join(', '));
      process.exit(1);
    }
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Wrote ${BASELINE}: ${total} calls over ${Object.keys(counts).length} files.`);
  } else if (risen.length > 0) {
    for (const [f, n] of risen) {
      console.error(`${f}: ${n} log calls in a failure path without errorFields(err) (baseline ${base[f] ?? 0})`);
    }
    console.error(
      'Fix: pass errorFields(err) from src/base/util/log.ts as the fields argument, or spread it into the existing fields.',
    );
    process.exit(1);
  } else {
    console.log(`Caught-error log ratchet OK: ${total} calls, none above ${BASELINE}.`);
  }
}
