#!/usr/bin/env node
// Fails when a src/ file other than src/util/env.ts touches process.env: configuration read ad hoc across the tree has
// no single place that lists the variables, their defaults and their parsing rules.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

/** Files allowed to touch process.env, each with its reason. Writes and child-process env passing belong here. */
export const ALLOWED = {
  'util/env.ts': 'the typed accessor module every other file reads through',
};

/**
 * Returns the 1-based line numbers in a source text that touch process.env.
 * @param {string} text
 * @returns {number[]}
 */
export function envReadLines(text) {
  // Every spelling of process.env (member, bracket, destructure) contains the word env, so other files skip the parse.
  if (!text.includes('env')) return [];
  return [...new Set(readFacts(text, 'file.ts', ['envReads']).envReads.map((r) => r.line))];
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Finds every process.env touch in srcDir outside the allow-list.
 * @param {string} srcDir
 * @param {Record<string, string>} [allowed]
 * @returns {{ file: string, line: number }[]}
 */
export function findEnvReads(srcDir, allowed = ALLOWED) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .filter(([file]) => !Object.hasOwn(allowed, file))
    .flatMap(([file, p]) => envReadLines(readFileSync(p, 'utf8')).map((line) => ({ file, line })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findEnvReads(srcDir);
  if (hits.length > 0) {
    console.error(`\n${hits.length} process.env access(es) in ${srcDir}/ outside util/env.ts:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}`);
    console.error(
      '\nFix: add a typed accessor to src/util/env.ts and call it, or add the file to ALLOWED in this script with a reason.\n',
    );
    process.exit(1);
  }
  console.log(`process.env is read only through ${srcDir}/util/env.ts. OK.`);
}
