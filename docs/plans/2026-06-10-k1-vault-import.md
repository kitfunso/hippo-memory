# K1 markdown-vault import baseline (plan, REVISED post plan-eng-critic R2)

Date: 2026-06-10 | Episode: `01KTRGYH3C58CYC7DZWNPQ5F7B` | Branch: `feat/k1-vault-import` (off `87746f3`) | Loop episode 1/15
Status: revised after plan-eng-critic R1 (CRIT) + R2 (2 HIGH). Re-gate R3 before execute.

## Goal
Add `importVault(folderPath, options)` to `src/importers.ts`: ingest a vault folder of `.md` notes as `kind='raw'` memories with frontmatter→A3 envelope, `[[wikilink]]`→`wikilink-candidate:<target>` tags, idempotency on `(path, content-hash)`, source-deletion sync, **provenance via tags** (`source:vault` + `vault:<name>` — matching the tag-based slack/github connectors; the `memories.source` column stays its default). CLI `--vault` flag. Fixture-gated per dialect. DEFER the E3.1 sleep-time *surfacing* (in-flight E3).

## Key decisions (audit + R1 + R2 review)
- **Mirror the CONNECTOR pattern** (`src/connectors/slack|github/deletion.ts` + `github/ingest.ts`), NOT the single-file importers. Connectors NEVER `supersede` a raw row: on change they APPEND a new `kind='raw'` row; on delete they `archiveRaw` ALL matching raw rows. They record provenance in **tags** (`source:slack`), column `source` defaults — K1 matches this.
- **NO new schema table** — memories-table-as-cursor. `artifactRef='vault:<name>:<relpath>'`; content-hash in a `content-hash:<hex>` tag.
- **R1 CRIT — changed file → `archiveRaw(oldId) + remember(new, kind='raw')`, NEVER `supersede`** (supersede yields `kind='distilled'`, losing raw-append-only protection + escaping the `kind='raw'` deletion rescan). Respects `trg_memories_raw_append_only` (db.ts:298: BEFORE DELETE WHEN kind='raw' → ABORT; `archiveRaw` flips to `'archived'` then deletes in a SAVEPOINT — the only legit raw-delete). archiveRaw commits + closes its handle before `remember(new)` runs (sequential, single-threaded), so no double-live row; a crash between them self-heals (the unchanged file is re-imported as fresh raw next run). Documented.
- **R1 HIGH — tenant-scoped** idempotency + deletion-sync (`AND tenant_id=? AND kind='raw'`).
- **R1 MED — single-scan Map.** No index on `memories.artifact_ref` (verified). Load the vault's existing rows ONCE into `Map<artifactRef,row>` (one query), reuse for BOTH per-file idempotency AND the deletion diff.
- **R2 HIGH — LIKE-escape the vault name.** `vaultName` is operator-supplied (`opts.name ?? basename`), so the prefix query MUST use `escapeLike(vaultName)` + `ESCAPE '\\'` (mirror `src/project-briefs.ts:477` / `assembleBriefFromReceipts`). Unescaped, a `%`/`_` in the name over-matches and the deletion diff could archiveRaw another vault's rows.
- **R2 HIGH — provenance tag-based** (above): Goal + mechanism + tests all assert the `source:vault` / `vault:<name>` TAGS, never a `source` column. (Threading the A3 `source` column through `remember()` for all connectors is a cross-cutting follow-up, out of K1 scope.)
- **Minimal inline frontmatter parser** (no YAML dep). Wikilinks → tags only (NOT `entities`/`relations`/`graph_extraction_queue`).

## Mechanism
1. `importVault(folderPath, opts)`: recursive readdir `*.md`; `relpath` rel to vault root; `vaultName = opts.name ?? basename(folderPath)`; `tenantId = ctx.tenantId`.
2. **Load once:** `existing = Map<artifactRef,row>` from one query `artifact_ref LIKE ? ESCAPE '\\' AND tenant_id=? AND kind='raw'` with param `` `vault:${escapeLike(vaultName)}:%` ``. `seen = Set<artifactRef>`.
3. Per file: read raw; `hash = sha256(raw)`; parse frontmatter (`^---\n…\n---\n`) → `{fm, body}`; fm `tags`/`aliases` → tags; parse `[[target]]`/`[[target|alias]]`→target → `wikilink-candidate:<target>` tags. `artifactRef='vault:<vaultName>:<relpath>'`; `seen.add(artifactRef)`.
4. Idempotency vs `existing.get(artifactRef)`: **absent** → `remember(kind='raw')`; **present + same `content-hash:<hash>` tag** → skip; **present + different hash** → `archiveRaw(oldId, reason='changed:vault:<vaultName>:<relpath>')` then `remember(new, kind='raw')`.
5. `remember(ctx,{content:body, kind:'raw', artifactRef, owner:'agent:vault-import', scope: opts.scope ?? null, tags:['source:vault',`vault:${vaultName}`,`content-hash:${hash}`,...fmTags,...wikilinkTags]})`.
6. **Deletion-sync (uses the Map):** for each `artifactRef` in `existing` but NOT in `seen` → file gone → `archiveRaw(row.id, reason='source_deleted:vault:<vaultName>:<relpath>')`. Per-file archiveRaw (own handle); no outer SAVEPOINT (no cross-file idempotency row to commit atomically, unlike github's multi-row case).
7. CLI: `--vault <path>` → `importVault`; update usage + dispatch. Return `ImportResult {total, imported, skipped, entries}`.

## Tests (real DB, no mocks)
`tests/importers-vault.test.ts` + `tests/fixtures/vault-imports/{obsidian,foam,dendron}-sample/`:
- (a) fixture vault imports: ≥95% notes as `kind='raw'` with the `source:vault` + `vault:<name>` TAGS + provenance;
- (b) re-import idempotent: 0 dups (unchanged files skipped via the hash tag);
- (c) changed file → OLD raw row archived (gone from `memories`, snapshot in raw_archive) AND new row is `kind='raw'` with the `source:vault` tag;
- (d) deleted file → its raw memory archived/invalidated;
- (e) `[[wikilinks]]` → `wikilink-candidate:<target>` tags (incl. `[[a|b]]`→a);
- (f) frontmatter tags/aliases mapped;
- (g) no crash on dialect syntax (Obsidian `^block-id`/`![[embed]]`, Dendron dot-hierarchy filenames, Foam plain md);
- (h) tenant isolation: a vault import in tenant A does NOT archive tenant B's `vault:<name>` rows;
- (i) **LIKE-escape isolation:** a vault literally named `a%` does NOT match/archive a vault named `ab`'s rows (escaped pattern).

## Resolved (was: open questions)
- **Q1** memories-as-cursor: keyed by artifactRef (relpath); move/rename = delete+add (lineage loss) accepted baseline; the `:` delimiter keeps per-relpath keying safe.
- **Q2/Q4** changed/raw → `archiveRaw(old)+remember(new,kind='raw')` (the CRIT fix), append-only-trigger-respecting; crash-window self-heals.
- **Q3** content-hash → `content-hash:<hex>` tag, no migration.
- **R2-provenance** → tag-based (`source:vault`/`vault:<name>`), column default; A3 source-column threading is a follow-up.
- **R2-escape** → `escapeLike` + `ESCAPE '\\'` on vaultName.

## Out of scope (deferred)
E3.1 sleep-time surfacing; `vault_cursors` table (scaling); A3 `source`-column threading; Obsidian Canvas / block-refs / embeds beyond no-crash.
