# Plan: E3.3 criterion-2 CI lint (graph writes funnel through the audited writer)

- Date: 2026-06-01
- Episode: 01KT1WR6GDV9M29TTKC6X091N4 (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Complete E3.3's last enforcement layer. The DB-level guard (v37 triggers) + the
pipeline-level table (graph_extraction_queue) shipped in the prior episode. E3.3's
success criterion 2 ("lint catches direct-write code paths" / "CI-level: a lint rule
fails any PR that introduces a code path writing to graph from non-consolidated
state") is the remaining piece. This ships a lint that enforces the architectural
invariant: **all writes to the graph tables (`entities`, `relations`,
`graph_extraction_queue`) funnel through the single audited writer `src/graph.ts`**
(whose `resolveConsolidatedSource` guard + the DB triggers enforce never-raw). A
second writer added anywhere else fails the lint at PR/CI time, before the DB guard
has to catch it at runtime.

## Why a lint when the DB guard is already airtight

Defense-in-depth + fast feedback + architecture. The v37 triggers make a raw-layer
reference unrepresentable at runtime regardless of code path. The lint adds: (a) PR-
time feedback (you learn at CI, not at a failing insert), and (b) the
"single-audited-writer" architectural invariant (every graph write goes through
`graph.ts`, which applies the helper guard + keeps writes auditable in one place).
Modest marginal value over the DB guard, but it is the roadmap's stated criterion 2
and cheap to maintain.

## Design

`scripts/check-graph-writes.mjs` (mirrors `scripts/check-em-dashes-in-release-notes.mjs`):

- Exports `findGraphWriteViolations(srcDir)`: recursively scan `srcDir` for `.ts`
  files, EXCLUDING the sanctioned writer `src/graph.ts`, and return
  `[{ file, line, text }]` for every line matching a graph-table DATA write:
  `/\b(INSERT\s+INTO|UPDATE)\s+(entities|relations|graph_extraction_queue)\b/i`.
  - Skips comment lines (trimmed line starts with `//`, `*`, or `/*`) to avoid
    false-matching a comment that mentions the pattern.
  - Targets DATA writes only: `CREATE TABLE entities`, `BEFORE INSERT ON entities`,
    `BEFORE UPDATE ON entities`, `SELECT ... FROM entities` do NOT match (the regex
    needs `INSERT INTO <table>` or `UPDATE <table>`, not `INSERT ON`/`UPDATE ON`/
    `FROM`), so the v37 migration in `src/db.ts` is naturally clean.
- A CLI main GUARDED by `if (process.argv[1] && fileURLToPath(import.meta.url) ===
  process.argv[1])` so importing the module from the test does NOT execute the CLI /
  `process.exit`. The CLI runs `findGraphWriteViolations('src')`, prints each
  violation, and `process.exit(1)` if any; else prints OK and exits 0.
- Wire into `package.json` `prepublishOnly` (after check-em-dashes, before build:all).

## Tests (real, no mocks)

`tests/graph-write-lint.test.ts` (imports the exported fn):
1. `findGraphWriteViolations('src')` on the REAL src tree returns `[]` (today only
   `src/graph.ts` writes the graph tables, and it is excluded).
2. Planted-violation fixture: a temp dir with a clean `.ts` file + a `.ts` file
   containing `db.prepare('INSERT INTO entities(...)')` and another with `UPDATE
   relations SET ...` -> the fn flags exactly those lines, not the clean file.
3. The sanctioned writer is excluded: a fixture `graph.ts` with an `INSERT INTO
   entities` is NOT flagged.
4. Comment-skip: a line `// INSERT INTO entities is only allowed in graph.ts` is NOT
   flagged.

(Plus a manual `node scripts/check-graph-writes.mjs` -> OK at verify.)

## Steps (each verify-checked)

1. scripts/check-graph-writes.mjs (exported fn + guarded CLI main).
2. package.json prepublishOnly: add `node scripts/check-graph-writes.mjs &&`.
3. tests/graph-write-lint.test.ts.
4. CHANGELOG Unreleased entry (em-dash-free).
5. build + vitest + manual lint run green.

## Risks & mitigations

- False-match in a comment -> skip comment lines (`//`, `*`, `/*`).
- False-match a different table (e.g. `correlations`) -> word-boundary `\b` +
  `INSERT INTO`/`UPDATE` prefix make this safe (`correlations` has no `\b` before
  `relations`).
- Importing the .mjs in the test must not run the CLI -> guarded main block.
- Migration data-backfill into a graph table (none today) would be flagged -> correct
  to flag; allow-list or route through graph.ts if ever needed (noted).
- NO migration / schema-bump / audit-ops / CLI / HTTP / SDK / Python this slice.
- codex review cwd-PINNED to hippo; all hippo bash commands cwd-prefixed.
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope

- The consolidation enqueue-hook (pairs with E3.1; ships the queue's producer).
- E3.1 entity extraction, E3.2 multi-hop recall, E3.4 graph-quality-under-supersession.
- AST-based analysis (a regex lint mirrors the existing check-em-dashes precedent and
  is sufficient for "no second graph-writer").
