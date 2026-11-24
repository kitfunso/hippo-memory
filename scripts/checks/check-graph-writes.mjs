#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from '../lib/ts-facts.mjs';

const GRAPH_TABLES = ['entities', 'relations', 'graph_extraction_queue'];
const GRAPH_TABLE_RE = new RegExp(GRAPH_TABLES.join('|'), 'i');
const WRITE_RE = new RegExp(
  `\\b(INSERT(\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+["'\\[]?\\s*(${GRAPH_TABLES.join('|')})\\b`,
  'gi',
);
const SANCTIONED_RELS = new Set(['store/sqlite/graph/graph-writes.ts', 'store/sqlite/graph/graph-queue.ts']);
const WRITER_NAMES = 'src/store/sqlite/graph/graph-writes.ts and src/store/sqlite/graph/graph-queue.ts';

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, onFile);
    else onFile(p);
  }
}

/**
 * Scan `srcDir` for graph-table DATA writes outside the sanctioned writers
 * (`SANCTIONED_RELS` under `srcDir`). Catches multi-line writes; ignores comments + DDL.
 * Returns `[{ file, line, text }]` (empty when clean).
 */
export function findGraphWriteViolations(srcDir) {
  const violations = [];
  walk(srcDir, (file) => {
    if (!file.endsWith('.ts')) return;
    if (SANCTIONED_RELS.has(relative(srcDir, file).replace(/\\/g, '/'))) return;
    const text = readFileSync(file, 'utf8');
    const origLines = text.split(/\r?\n/);
    if (!GRAPH_TABLE_RE.test(text)) return;
    for (const literal of readFacts(text, file, ['strings']).strings) {
      for (const m of literal.text.matchAll(WRITE_RE)) {
        const line = literal.line + literal.text.slice(0, m.index).split('\n').length - 1;
        violations.push({ file, line, text: (origLines[line - 1] ?? m[0]).trim() });
      }
    }
  });
  return violations;
}

// CLI main. Guarded so importing this module (e.g. from the test) does NOT run the
// check or process.exit. pathToFileURL(argv[1]) normalises to a file:// URL that
// matches import.meta.url cross-platform (Windows path separators / drive casing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const violations = findGraphWriteViolations(srcDir);
  if (violations.length > 0) {
    console.error('');
    console.error(`Graph-write violation(s): the graph tables (${GRAPH_TABLES.join(', ')}) may only be`);
    console.error(`written through the sanctioned writers ${WRITER_NAMES}, but found DATA writes elsewhere:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
    console.error('');
    console.error('Fix: route the write through the store graph writers (insertEntityRow / insertRelationRow /');
    console.error('enqueueExtraction), which applies the consolidated-source guard. The graph must');
    console.error('never index the raw layer (ROADMAP-RESEARCH E3.3).');
    console.error('');
    process.exit(1);
  }
  console.log(`No graph-write violations in ${srcDir}/. All graph writes funnel through ${WRITER_NAMES}. OK.`);
}
