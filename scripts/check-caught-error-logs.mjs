#!/usr/bin/env node
// Per-file count of log calls inside a catch block or `.catch` callback that omit errorFields() may fall, never rise,
// so an operator reading the log sees the error class and stack of every caught failure.
// Usage: check-caught-error-logs.mjs [--update]. --update rewrites the baseline and refuses to raise a number.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { stripComments } from './lib/source-text.mjs';

const BASELINE = '.caught-error-logs-baseline.json';
const LOGGERS = new Set(['log', 'logger']);

const isLogCall = (n) =>
  ts.isCallExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  ts.isIdentifier(n.expression.expression) &&
  LOGGERS.has(n.expression.expression.text);

/** The body a node hands to the failure path: a catch clause's block, or the callback of a `.catch(...)` call. */
function failureBodies(node) {
  if (ts.isCatchClause(node)) return [node.block];
  const callee =
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression : undefined;
  if (callee?.name.text !== 'catch') return [];
  return node.arguments.filter((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)).map((a) => a.body);
}

/**
 * Returns the 1-based line of every log call inside a catch block or `.catch` callback that does not mention errorFields.
 * @param {string} text
 * @returns {number[]}
 */
export function unfieldedLogLines(text) {
  const sf = ts.createSourceFile('x.ts', stripComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits = new Map();
  const collect = (node) => {
    if (isLogCall(node) && !node.getText(sf).includes('errorFields')) {
      hits.set(node.getStart(sf), sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node) => {
    for (const body of failureBodies(node)) collect(body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits.values()].sort((a, b) => a - b);
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
      console.error(`${f}: ${n} log calls in a catch without errorFields(err) (baseline ${base[f] ?? 0})`);
    }
    console.error(
      'Fix: pass errorFields(err) from src/util/log.ts as the fields argument, or spread it into the existing fields.',
    );
    process.exit(1);
  } else {
    console.log(`Caught-error log ratchet OK: ${total} calls, none above ${BASELINE}.`);
  }
}
