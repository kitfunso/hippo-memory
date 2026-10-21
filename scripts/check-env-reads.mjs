#!/usr/bin/env node
// Fails when a src/ file other than src/base/util/env.ts touches process.env, or when a module outside the
// composition roots and adapters imports it: the roots read the environment once and pass settings down.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

/** Files allowed to touch process.env, each with its reason. Writes and child-process env passing belong here. */
export const ALLOWED = {
  'base/util/env.ts': 'the typed accessor module every other file reads through',
};

/** Files that may import base/util/env.ts, each with its reason. */
export const ENV_READERS = [
  [/^(?:cli\.ts$|surface\/cli\/)/, 'the CLI composition root'],
  [/^surface\/server\//, 'the HTTP server composition root'],
  [/^surface\/mcp\//, 'the stdio MCP composition root'],
  [/^(?:domain\/hooks|surface\/hooks-install)\//, 'the hook entry points and installers the CLI root runs'],
  [/^support-bundle\.ts$/, 'reports which variables are set'],
  [/^(?:domain\/rerankers|base\/embeddings)\//, 'adapters: their own endpoint, key, model and timeout'],
  [
    /^surface\/connectors\/[^/]+\/webhook\.ts$/,
    'webhook adapters: their own signing secrets and unknown-tenant escape hatch',
  ],
  [/^base\/memory\/ablation\.ts$/, 'the eval-only HIPPO_ABLATE_* and HIPPO_FAKE_NOW switches'],
  [/^infra\//, 'the outside-service adapters: their own key, timeout, model cache and machine'],
  [/^base\/util\/log\.ts$/, 'the log sink: its own level and format'],
  [/^base\/util\/spawn-argv\.ts$/, 'the process adapter: PATH and PATHEXT'],
  [/^base\/util\/agent-homes\.ts$/, 'machine locations: home folders and HIPPO_HOME'],
];

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

/** The lines of `file` (a path under src) that import base/util/env.ts, envTenant included: the roots resolve the tenant. */
export function envImportLines(file, text) {
  if (!text.includes('env')) return [];
  const isEnv = (spec) =>
    spec.startsWith('.') &&
    posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '') === 'base/util/env';
  return readFacts(text, file, ['imports', 'dynamic'])
    .imports.filter((i) => isEnv(i.spec))
    .map((i) => i.line);
}

/** Every base/util/env.ts import in srcDir outside the files `readers` names. */
export function findEnvImports(srcDir, readers = ENV_READERS) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .filter(([file]) => file !== 'base/util/env.ts' && !readers.some(([pattern]) => pattern.test(file)))
    .flatMap(([file, p]) => envImportLines(file, readFileSync(p, 'utf8')).map((line) => ({ file, line })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function report(srcDir, hits, what, fix) {
  if (hits.length === 0) return true;
  console.error(`\n${hits.length} ${what}:`);
  for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}`);
  console.error(`\nFix: ${fix}\n`);
  return false;
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const readsOk = report(
    srcDir,
    findEnvReads(srcDir),
    `process.env access(es) in ${srcDir}/ outside base/util/env.ts`,
    'add a typed accessor to src/base/util/env.ts and call it, or add the file to ALLOWED in this script with a reason.',
  );
  const importsOk = report(
    srcDir,
    findEnvImports(srcDir),
    `base/util/env.ts import(s) in ${srcDir}/ outside the composition roots and adapters`,
    'read the variable in a root (src/surface/cli, src/surface/server, src/surface/mcp) and pass the value down as a parameter or config.',
  );
  if (!readsOk || !importsOk) process.exit(1);
  console.log(
    `process.env is read only through ${srcDir}/base/util/env.ts, and only roots and adapters import it. OK.`,
  );
}
