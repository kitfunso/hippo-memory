#!/usr/bin/env node
// Fails when a CLI file turns a flag into text by hand. parseArgs hands a value-less flag over as `true`, so
// `String(flags[x] ?? '')` stores the word "true"; the helpers in src/cli/flag-values.ts reject it instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isTsSource, readFacts } from './lib/ts-facts.mjs';

/** `flags.x` or `flags[k]`: the parsed-flags object read for one flag. */
const isFlagRead = (n) => (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(n.expression) && n.expression.text === 'flags';

/** True when the expression starts with a flag read, as in `flags.x ?? ''` or `flags.x.trim()`. */
function startsWithFlag(e) {
  for (let n = e; ; ) {
    if (isFlagRead(n)) return true;
    if (ts.isBinaryExpression(n)) n = n.left;
    else if (ts.isConditionalExpression(n)) n = n.condition;
    else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else return false;
  }
}

/** `String(flags.x)`, a `${flags.x}` template span, or `flags.x as string`; `as string[]` is a list cast, not a text read. */
function isHandRead(n) {
  if (ts.isCallExpression(n)) return ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments[0] !== undefined && startsWithFlag(n.arguments[0]);
  if (ts.isTemplateSpan(n)) return isFlagRead(n.expression);
  return ts.isAsExpression(n) && n.type.kind === ts.SyntaxKind.StringKeyword && isFlagRead(n.expression);
}

/**
 * Returns the 1-based line numbers in a source text that read a flag as text by hand.
 * @param {string} text
 * @returns {number[]}
 */
export function handFlagLines(text) {
  const { sourceFile } = readFacts(text);
  const lines = new Set();
  const visit = (n) => {
    if (isHandRead(n)) lines.add(sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return [...lines].sort((x, y) => x - y);
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (isTsSource(name)) out.push(p);
  }
  return out;
}

/**
 * Finds every hand-rolled flag read in src/cli.ts and src/cli/ under srcDir.
 * @param {string} srcDir
 * @returns {{ file: string, line: number }[]}
 */
export function findHandFlagReads(srcDir) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .filter(([file]) => file === 'cli.ts' || file.startsWith('cli/'))
    .flatMap(([file, p]) => handFlagLines(readFileSync(p, 'utf8')).map((line) => ({ file, line })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findHandFlagReads(srcDir);
  if (hits.length > 0) {
    console.error(`\n${hits.length} hand-rolled flag read(s) in the CLI under ${srcDir}/:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}`);
    console.error('\nFix: read the flag through stringFlagOrExit, nonEmptyStringFlag, stringListFlag or numberFlag in src/cli/flag-values.ts.\n');
    process.exit(1);
  }
  console.log('CLI flags are read only through src/cli/flag-values.ts. OK.');
}
