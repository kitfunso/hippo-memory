#!/usr/bin/env node
// Compares the exported names of every index.d.ts and entry/*.d.ts under --before with ./dist, so a build that drops a
// published name shows up before it ships. Exits 1 on a removed name unless --allow-removed is passed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stripComments } from './lib/source-text.mjs';

const DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function|class|interface|type|enum|namespace)\s+([\w$]+)/gm;
const NAMED_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;
const STAR = /^export\s+(?:type\s+)?\*(?:\s+as\s+([\w$]+))?\s+from\s+['"]([^'"]+)['"]/gm;
const DEFAULT = /^export\s+default\b/m;

/** Names a d.ts text exports; only column-0 `export` lines count, so a namespace's members stay out. */
function exportedNames(text) {
  const src = stripComments(text);
  const names = new Set();
  for (const m of src.matchAll(DECLARATION)) names.add(m[1]);
  for (const m of src.matchAll(NAMED_LIST)) {
    for (const item of m[1].split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(STAR)) names.add(m[1] ?? `* from '${m[2]}'`);
  if (DEFAULT.test(src)) names.add('default');
  return names;
}

function entryFiles(root) {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => basename(p) === 'index.d.ts' || /^entry\/[^/]+\.d\.ts$/.test(p))
    .sort();
}

function namesByFile(root) {
  return new Map(entryFiles(root).map((file) => [file, exportedNames(readFileSync(join(root, file), 'utf8'))]));
}

/** One row per file whose names changed; a file gone from `after` counts as every name removed. */
function diffTrees(before, after) {
  const rows = [];
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const file of files) {
    const was = before.get(file) ?? new Set();
    const now = after.get(file) ?? new Set();
    const added = [...now].filter((n) => !was.has(n)).sort();
    const removed = [...was].filter((n) => !now.has(n)).sort();
    if (added.length > 0 || removed.length > 0) rows.push({ file, added, removed });
  }
  return { rows, compared: files.length };
}

function parseArgs(argv) {
  const args = { before: null, allowRemoved: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') args.before = argv[++i] ?? null;
    else if (argv[i] === '--allow-removed') args.allowRemoved = true;
    else return null;
  }
  return args.before ? args : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: node scripts/check-dts-diff.mjs --before <dir> [--allow-removed]');
    return 2;
  }
  for (const dir of [args.before, 'dist']) {
    if (!existsSync(dir)) {
      console.error(`check-dts-diff: ${dir} does not exist`);
      return 2;
    }
  }
  const { rows, compared } = diffTrees(namesByFile(args.before), namesByFile('dist'));
  for (const { file, added, removed } of rows) {
    console.log(file);
    for (const n of added) console.log(`  + ${n}`);
    for (const n of removed) console.log(`  - ${n}`);
  }
  const count = (key) => rows.reduce((sum, r) => sum + r[key].length, 0);
  console.log(`check-dts-diff: ${compared} files compared, ${count('added')} names added, ${count('removed')} removed`);
  if (count('removed') === 0 || args.allowRemoved) return 0;
  console.error('A removed name breaks a published surface; pass --allow-removed only for an intended major release.');
  return 1;
}

process.exitCode = main();
