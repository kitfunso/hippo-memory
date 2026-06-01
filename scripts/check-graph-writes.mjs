#!/usr/bin/env node
/**
 * E3.3 graph-on-consolidated guard - criterion 2 (CI-level enforcement).
 *
 * The graph layer (entities / relations / graph_extraction_queue) must only ever be
 * written through the single audited writer `src/graph.ts`, whose
 * `resolveConsolidatedSource` guard + the v37 DB triggers make a raw-layer reference
 * unrepresentable. This lint enforces the architectural invariant at PR/CI time as
 * defense-in-depth on top of the runtime DB guard: it fails if any other source file
 * contains a DATA write (INSERT INTO / UPDATE) to a graph table.
 *
 * The DB triggers are the airtight runtime backstop; this is fast PR-time feedback +
 * the "single graph-writer" rule. Regex-based (mirrors
 * scripts/check-em-dashes-in-release-notes.mjs); a write split across multiple lines
 * would slip the line-scan but is still caught at runtime by the DB guard.
 *
 * Ticket: ROADMAP-RESEARCH.md E3.3 success criterion 2.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

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
/** The one sanctioned writer, as a path RELATIVE TO srcDir (exact, not basename): a
 *  hypothetical `src/sub/graph.ts` is NOT the sanctioned writer and must be linted
 *  (codex-review 2026-06-01, P2). */
const SANCTIONED_REL = 'graph.ts';

/**
 * Blank out comments (block `/* *​/` and line `//`) by replacing their characters with
 * spaces, PRESERVING newlines + byte offsets, so (a) a comment that merely mentions
 * the SQL pattern is not a false positive, and (b) match offsets still map to the
 * original file's line numbers. Naive re: a `//` inside a string literal is also
 * blanked, but that only matters if such a string also contained a real graph-write
 * pattern (absurd) - acceptable for a regex lint (mirrors check-em-dashes).
 */
function blankComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, onFile);
    else onFile(p);
  }
}

/**
 * Scan `srcDir` for graph-table DATA writes outside the sanctioned writer
 * (`<srcDir>/graph.ts`). Catches multi-line writes; ignores comments + DDL.
 * Returns `[{ file, line, text }]` (empty when clean).
 */
export function findGraphWriteViolations(srcDir) {
  const violations = [];
  walk(srcDir, (file) => {
    if (!file.endsWith('.ts')) return;
    // Allow ONLY the single sanctioned writer at the srcDir root (exact relative path).
    if (relative(srcDir, file).replace(/\\/g, '/') === SANCTIONED_REL) return;
    const text = readFileSync(file, 'utf8');
    const blanked = blankComments(text);
    const origLines = text.split(/\r?\n/);
    WRITE_RE.lastIndex = 0;
    let m;
    while ((m = WRITE_RE.exec(blanked)) !== null) {
      // 1-based line of the matched verb (start of the match).
      const line = blanked.slice(0, m.index).split('\n').length;
      violations.push({ file, line, text: (origLines[line - 1] ?? m[0]).trim() });
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
    console.error(`written through the sanctioned writer src/${SANCTIONED_REL}, but found DATA writes elsewhere:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
    console.error('');
    console.error('Fix: route the write through src/graph.ts (insertEntity / insertRelation /');
    console.error('enqueueExtraction), which applies the consolidated-source guard. The graph must');
    console.error('never index the raw layer (ROADMAP-RESEARCH E3.3).');
    console.error('');
    process.exit(1);
  }
  console.log(`No graph-write violations in ${srcDir}/. All graph writes funnel through src/${SANCTIONED_REL}. OK.`);
}
