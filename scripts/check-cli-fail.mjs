#!/usr/bin/env node
// Fails when a CLI file prints an error and then throws CliExit(1) by hand. fail() in src/cli/exit.ts does both,
// so the message and the exit code cannot drift apart. Zero allowed, no baseline.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './lib/source-text.mjs';

const THROW_EXIT_1 = /^\s*;\s*throw\s+new\s+CliExit\(\s*1\s*\)\s*;?/;
const OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}' };

/** Index just past the string or template literal that starts at text[i]. `${...}` code inside a template is skipped by bracket match. */
function skipQuoted(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j + 1;
    else if (quote === '`' && text[j] === '$' && text[j + 1] === '{') j = matchClose(text, j + 1);
  }
  return text.length;
}

/** Index of the bracket that closes the one at text[open], stepping over strings. */
function matchClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') i = skipQuoted(text, i) - 1;
    else if (c in OPEN_TO_CLOSE) depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/**
 * Finds each `printError(...)` whose next statement is `throw new CliExit(1)`.
 * @param {string} code source text with its comments already blanked
 * @returns {{ start: number, end: number }[]} offsets into the text: the printError call, and the end of the throw
 */
export function failPairs(code) {
  const pairs = [];
  for (const m of code.matchAll(/\bprintError\(/g)) {
    // A braceless `for (...) printError(x);` or `if (c) printError(x);` leaves the throw unconditional, so it is no pair.
    const prev = code.slice(0, m.index).trimEnd().slice(-1);
    if (prev !== '' && !';{}:'.includes(prev)) continue;
    const close = matchClose(code, m.index + m[0].length - 1);
    const next = THROW_EXIT_1.exec(code.slice(close + 1));
    if (next) pairs.push({ start: m.index, end: close + 1 + next[0].length });
  }
  return pairs;
}

/**
 * Returns the 1-based line numbers of the printError calls that a hand-written throw follows.
 * @param {string} text
 * @returns {number[]}
 */
export function failPairLines(text) {
  const code = stripComments(text);
  return failPairs(code).map(({ start }) => code.slice(0, start).split('\n').length);
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Finds every print-then-throw pair in src/cli.ts and src/cli/ under srcDir.
 * @param {string} srcDir
 * @returns {{ file: string, line: number }[]}
 */
export function findFailPairs(srcDir) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    // exit.ts holds the one allowed pair: the body of fail().
    .filter(([file]) => (file === 'cli.ts' || file.startsWith('cli/')) && file !== 'cli/exit.ts')
    .flatMap(([file, p]) => failPairLines(readFileSync(p, 'utf8')).map((line) => ({ file, line })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findFailPairs(srcDir);
  if (hits.length > 0) {
    console.error(`\n${hits.length} printError + throw new CliExit(1) pair(s) in the CLI under ${srcDir}/:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}`);
    console.error('\nFix: call fail(...) from src/cli/exit.ts, which prints the message and exits 1.\n');
    process.exit(1);
  }
  console.log('Every CLI error exit goes through fail(). OK.');
}
