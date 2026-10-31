#!/usr/bin/env node
// Fails when a CLI file turns a flag into text by hand. parseArgs hands a value-less flag over as `true`, so
// `String(flags[x] ?? '')` stores the word "true"; the helpers in src/cli/flag-values.ts reject it instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './lib/source-text.mjs';

const FLAG = String.raw`flags\s*(?:\[[^\]]*\]|\.\w+)`;

/** Hand-rolled flag-to-text shapes. `as string[]` is a list cast, not a text read, so it passes. */
const PATTERNS = [
  new RegExp(String.raw`\bString\(\s*${FLAG}`),
  new RegExp(String.raw`\$\{\s*${FLAG}\s*\}`),
  new RegExp(String.raw`\b${FLAG}\s+as\s+string\b(?!\s*\[)`),
];

/**
 * Returns the 1-based line numbers in a source text that read a flag as text by hand.
 * @param {string} text
 * @returns {number[]}
 */
export function handFlagLines(text) {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) => (PATTERNS.some((re) => re.test(line)) ? [i + 1] : []));
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
