#!/usr/bin/env node
// Fails when the CLI ranks or records a recall itself: `hippo recall` and `hippo explain` go through retrieve(),
// which owns the ranking core and every row a recall writes, so the three surfaces cannot drift apart again.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  'updateStats',
  'updateStatsUnlessBusy',
  'openHippoDb',
];

/** The files that implement the recall verbs, relative to the source root. */
export const RECALL_VERB_FILES = ['cli/recall.ts', 'cli/explain.ts'];

/** Blanks comments, keeping line numbers, so prose that names a writer is not a call. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

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
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .filter(([file]) => file === 'cli.ts' || file.startsWith('cli/'))
    .flatMap(([file, p]) => {
      const banned = RECALL_VERB_FILES.includes(file) ? [...RECALL_ONLY, ...SHARED_WRITERS] : RECALL_ONLY;
      return namedOnLines(readFileSync(p, 'utf8'), banned).map((hit) => ({ file, ...hit }));
    })
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
    process.exit(1);
  }
  console.log(`The CLI ranks and records recall only through retrieve(). OK.`);
}
