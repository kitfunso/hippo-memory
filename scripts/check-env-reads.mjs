#!/usr/bin/env node
// Fails when a src/ file other than src/util/env.ts touches process.env: configuration read ad hoc across the tree has
// no single place that lists the variables, their defaults and their parsing rules.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files allowed to touch process.env, each with its reason. Writes and child-process env passing belong here. */
export const ALLOWED = {
  'util/env.ts': 'the typed accessor module every other file reads through',
};

const PATTERNS = [
  /\bprocess\s*(?:\?\.|\.)\s*env\b/,
  /\bprocess\s*\[\s*['"`]env['"`]\s*\]/,
  /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
];

/** Blanks comments, keeping line numbers, so prose about process.env is not a read. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Returns the 1-based line numbers in a source text that touch process.env.
 * @param {string} text
 * @returns {number[]}
 */
export function envReadLines(text) {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) => (PATTERNS.some((re) => re.test(line)) ? [i + 1] : []));
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
    console.error('\nFix: add a typed accessor to src/util/env.ts and call it, or add the file to ALLOWED in this script with a reason.\n');
    process.exit(1);
  }
  console.log(`process.env is read only through ${srcDir}/util/env.ts. OK.`);
}
