#!/usr/bin/env node
/**
 * E3.3 graph-on-consolidated guard - criterion 2 (CI-level enforcement).
 *
 * The graph layer (entities / relations / graph_extraction_queue) must only ever be
 * written through the audited store writers `src/store/graph-writes.ts` and
 * `src/store/graph-queue.ts`, whose `resolveConsolidatedSource` guard + the v37 DB
 * triggers make a raw-layer reference unrepresentable. This lint enforces the architectural invariant at PR/CI time as
 * defense-in-depth on top of the runtime DB guard: it fails if any other source file
 * contains a DATA write (INSERT INTO / UPDATE) to a graph table.
 *
 * The DB triggers are the airtight runtime backstop; this is fast PR-time feedback +
 * the "single graph-writer" rule. The SQL text is read from the string and template
 * literals of the TypeScript parse, so a comment that names a write never counts.
 *
 * Ticket: ROADMAP-RESEARCH.md E3.3 success criterion 2.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

const GRAPH_TABLES = ['entities', 'relations', 'graph_extraction_queue'];
/** A DATA write to a graph table: `INSERT INTO <table>`, `UPDATE <table>`, or
 *  `DELETE FROM <table>`. Does NOT match `CREATE TABLE <table>`,
 *  `BEFORE INSERT ON <table>`, `BEFORE UPDATE ON <table>`, or `SELECT ... FROM <table>`
 *  (the v37 migration DDL). DELETE is included so the "single graph-writer" rule covers
 *  all of INSERT/UPDATE/DELETE (code-review 2026-06-01); graph deletes today happen via
 *  ON DELETE CASCADE, not a direct DELETE, so this flags only a future bypass. */
// Global + newline-tolerant: `\s+` matches across line breaks, so a write split over
// multiple lines (`INSERT INTO\n  entities(...)`) is still caught (codex-review
// 2026-06-01, P2). `g` so we can find every match + its offset for line reporting.
// Covers SQLite write variants (codex-review 2026-06-01, retry P2): an optional
// `OR IGNORE|REPLACE|ROLLBACK|ABORT|FAIL` modifier after INSERT, and an optional
// quoted/bracketed table identifier (`"entities"`, `[entities]`). NOTE: this is a
// BEST-EFFORT defense-in-depth lint - the v37 DB triggers are the airtight runtime
// enforcement of the never-raw invariant; a determined bypass (dynamic SQL / string
// concatenation / schema-qualified `main.entities`) is out of scope for a regex lint
// and irrelevant to the never-raw guarantee. (Backtick-quoted identifiers cannot occur
// in this codebase's SQL, which lives inside JS backtick template literals.)
const WRITE_RE = new RegExp(
  `\\b(INSERT(\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+["'\\[]?\\s*(${GRAPH_TABLES.join('|')})\\b`,
  'gi',
);
/** The sanctioned writers, as paths RELATIVE TO srcDir (exact, not basename): a
 *  hypothetical `src/sub/store/graph-writes.ts` is NOT a sanctioned writer and must be linted. */
const SANCTIONED_RELS = new Set(['store/graph-writes.ts', 'store/graph-queue.ts']);
const WRITER_NAMES = 'src/store/graph-writes.ts and src/store/graph-queue.ts';

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
    // Allow ONLY the sanctioned writers (exact path relative to srcDir).
    if (SANCTIONED_RELS.has(relative(srcDir, file).replace(/\\/g, '/'))) return;
    const text = readFileSync(file, 'utf8');
    const origLines = text.split(/\r?\n/);
    for (const literal of readFacts(text, file).strings) {
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
