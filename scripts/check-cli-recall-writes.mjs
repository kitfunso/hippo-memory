#!/usr/bin/env node
// Fails when the CLI ranks or records a recall itself: `hippo recall` and `hippo explain` go through retrieve(),
// which owns the ranking core and every row a recall writes, so the three surfaces cannot drift apart again.
// Also fails when a CLI file names a memory writer or the store opener: a verb's row change lives behind a function that takes the store root.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './lib/source-text.mjs';

/** The ranking core and the writers only a recall uses. No CLI file may name one. */
export const RECALL_ONLY = [
  'rankRecall',
  'writeRecallTrace',
  'writeRecallTraceAtRoot',
  'writeGoalRecallLog',
  'finishRecall',
  'finishRecallAt',
  'strengthenRetrieved',
  'strengthenRetrievedInOwnTx',
  'strengthenRetrievedOn',
  'saveIndex',
  'bumpRecallStats',
];

/** Writers other verbs need for their own rows (audit, token ledger, stats, a raw handle). The recall verbs may not name one. */
export const SHARED_WRITERS = [
  'appendAuditEvent',
  'appendAuditEventStrict',
  'recordTokenUse',
  'recordTokens',
  'withLedgerDb',
  'bookTokenUse',
  'bookLedgerTurn',
  'updateStats',
  'updateStatsUnlessBusy',
  'openHippoDb',
];

/** The files that implement the recall verbs, relative to the source root. */
export const RECALL_VERB_FILES = ['cli/recall.ts', 'cli/explain.ts'];

/** The memory writers and the store opener. A CLI verb reaches them through a root-taking function in src/api or the module that owns the rows. */
export const STORE_WRITERS = ['writeEntry', 'deleteEntry', 'deleteEntryCore', 'batchWriteAndDelete', 'openHippoDb'];

/** The CLI files that may still name some of them, each with its reason. A new entry needs one too.
 * @type {Record<string, string[]>} */
export const STORE_WRITER_EXCEPTIONS = {};

/**
 * Returns each line of a source text that names one of `names` as an identifier, imports included.
 * @param {string} text
 * @param {readonly string[]} names
 * @returns {{ line: number, name: string }[]}
 */
export function namedOnLines(text, names) {
  const wanted = new Set(names);
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) => [...new Set(line.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter((id) => wanted.has(id)).map((name) => ({ line: i + 1, name })));
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
 * Finds every CLI file under srcDir that names a recall-only function, and every recall verb file that names a shared writer.
 * @param {string} srcDir
 * @returns {{ file: string, line: number, name: string }[]}
 */
export function findCliRecallWrites(srcDir) {
  return findInCli(srcDir, (file) => (RECALL_VERB_FILES.includes(file) ? [...RECALL_ONLY, ...SHARED_WRITERS] : RECALL_ONLY));
}

/**
 * Finds every CLI file under srcDir that names a memory writer or the store opener it has no exception for.
 * @param {string} srcDir
 * @returns {{ file: string, line: number, name: string }[]}
 */
export function findCliStoreWrites(srcDir) {
  return findInCli(srcDir, (file) => STORE_WRITERS.filter((name) => !(STORE_WRITER_EXCEPTIONS[file] ?? []).includes(name)));
}

/** Each line of a CLI file under srcDir that names one of the identifiers `bannedIn` answers for that file, sorted. */
function findInCli(srcDir, bannedIn) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .filter(([file]) => file === 'cli.ts' || file.startsWith('cli/'))
    .flatMap(([file, p]) => namedOnLines(readFileSync(p, 'utf8'), bannedIn(file)).map((hit) => ({ file, ...hit })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findCliRecallWrites(srcDir);
  if (hits.length > 0) {
    console.error(`\n${hits.length} recall ranking or recording reference(s) in the CLI under ${srcDir}/:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}: ${h.name}`);
    console.error('\nFix: pass the input to retrieve() (src/api/recall.ts) and let it rank and record; the CLI parses flags and prints.\n');
  }
  const writes = findCliStoreWrites(srcDir);
  if (writes.length > 0) {
    console.error(`\n${writes.length} memory writer or store opener reference(s) in the CLI under ${srcDir}/:`);
    for (const h of writes) console.error(`  ${srcDir}/${h.file}:${h.line}: ${h.name}`);
    console.error('\nFix: move the row change into a function that takes the store root, in src/api or the module that owns the rows, and call that.\n');
  }
  if (hits.length + writes.length > 0) process.exit(1);
  console.log('The CLI ranks and records recall only through retrieve(). OK.');
  console.log('The CLI writes memories and opens the store only through functions that take the root. OK.');
}
