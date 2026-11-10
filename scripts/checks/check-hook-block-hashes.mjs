#!/usr/bin/env node
// Fails when the built hook block text of an agent has no hash in SHIPPED_HOOK_HASHES: init refreshes a block it
// wrote earlier only if the hash of that text is listed. Run after build; `--root <dir>` checks a copy of the repo.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BLOCKS = 'surface/hooks-install/rules/hook-blocks';

function stop(message) {
  console.error(message);
  process.exit(2);
}

function rootFromArgs(args) {
  const at = args.indexOf('--root');
  if (at < 0) return fileURLToPath(new URL('../..', import.meta.url));
  if (!args[at + 1]) stop('--root needs a folder: node scripts/checks/check-hook-block-hashes.mjs --root <dir>');
  return resolve(args[at + 1]);
}

/**
 * The 64-hex quoted literals between `SHIPPED_HOOK_HASHES = new Map([` and the first `]);`. A regex on the source is
 * best-effort: it reads a flat list of quoted hashes, and a list built any other way (spread, computed) is not seen.
 * @param {string} source
 * @returns {Set<string> | null} null when the list is not found
 */
function listedHashes(source) {
  const list = /SHIPPED_HOOK_HASHES\s*=\s*new Map\(\[([\s\S]*?)\]\);/.exec(source);
  return list ? new Set([...list[1].matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1])) : null;
}

const root = rootFromArgs(process.argv.slice(2));
const distFile = join(root, 'dist', `${BLOCKS}.js`);
const srcFile = join(root, 'src', `${BLOCKS}.ts`);
if (!existsSync(distFile)) stop(`${distFile} is missing: run \`npm run build\` first.`);
if (!existsSync(srcFile)) stop(`${srcFile} is missing: --root must be a repo folder with its src.`);

const listed = listedHashes(readFileSync(srcFile, 'utf8'));
if (!listed) stop(`${srcFile} has no \`SHIPPED_HOOK_HASHES = new Map([ ... ]);\` list this check can read.`);

let HOOKS;
try {
  ({ HOOKS } = await import(pathToFileURL(distFile).href));
} catch (err) {
  stop(`${distFile} does not load (${err.code ?? err.message}): run \`npm run build\` first.`);
}

const agents = Object.entries(HOOKS);
const missing = agents
  .map(([agent, spec]) => ({ agent, hash: createHash('sha256').update(spec.content).digest('hex') }))
  .filter(({ hash }) => !listed.has(hash));

if (missing.length > 0) {
  console.error(`\nHook block text whose hash SHIPPED_HOOK_HASHES lacks (${srcFile}):`);
  for (const { agent, hash } of missing) console.error(`  ${agent}: add  ['${hash}', '${agent}'],`);
  console.error('\nFix: add each line to the list, so init still refreshes a block written from this text.\n');
  process.exit(1);
}
console.log(
  `All ${agents.length} hook block texts have their hash in SHIPPED_HOOK_HASHES (${listed.size} listed). OK.`,
);
