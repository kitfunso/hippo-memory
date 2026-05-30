# Plan: E2 first-class `project_brief` object (repo-scoped / auto-refreshes)

- Date: 2026-05-30
- Episode: 01KSWQDQQN3YJ9FMSBG64S0X19 (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `project_brief` to a first-class E2 object (after decision / prediction /
incident / process / policy / skill), mirroring `src/skills.ts`. ROADMAP-RESEARCH
specs it as "repo-scoped; auto-refreshes from receipts". A project_brief is the
living summary of a repository's state: a `summary` body scoped to a `repo`,
evolving via the supersede delta lifecycle, with a **refresh** operation that
auto-assembles the brief body from the repo's recent receipts.

## Key design: "auto-refreshes from receipts" = deterministic assembler (NOT an LLM/async daemon)

The brainstorm grill settled the central ambiguity, mirroring how the skill episode
settled "executable". A full async re-summarization pipeline (LLM call on every
repo write + staleness tracking + a scheduler) is large, needs LLM infra, and is
exactly the scope-creep trap. The safe + faithful literal reading of "auto-refreshes
from receipts": a **deterministic, no-LLM assembler** that gathers the repo's recent
receipts and renders them into the brief body. "Auto" = the operator runs one
`brief refresh <repo>` and the body is regenerated from current receipts (vs
hand-writing it). The distinguishing capability is therefore the **refresh assembler**
(analog of skill's export renderer). LLM prose summarization is explicitly DEFERRED
as a clean future extension behind the same deterministic seam.

A **receipt** in hippo = a memory row that is evidence (an `artifact_ref` URI, or a
raw/distilled memory). The CLI already path-tags every write via
`extractPathTags(cwd)` -> `path:<segment>` (lowercased). A repo's receipts are the
tenant's memory rows carrying that repo's `path:<repo>` tag.

**`repo` semantics (grill clarification):** `repo` is the repo IDENTIFIER - the
directory-name segment `extractPathTags` emits (e.g. `hippo`), NOT a full path. The
brief stores whatever the operator passes (display); refresh tag-matches
`path:<repo-lowercased>`. So `brief refresh hippo` matches `path:hippo`.

**Receipt-coverage limitation (grill, explicit):** path tags are applied only by the
CLI write path (`extractPathTags(process.cwd())`, cli.ts:751). Memories ingested via
HTTP/SDK or the Slack connector carry NO `path:` tag, so v1 `refreshBrief` does not
see them. This is acceptable for v1 - the brief is a repo-local operator tool run
from the repo (CLI context). Widening the receipt match to also union the memory
`scope` field (`project:<repo>`) is noted as a future extension, not v1.

project_brief reuses the skill/process supersede machinery verbatim (`superseded_by`
self-FK + CAS + INSERT-preflight + server-derived version + change_summary +
supersede tenant-match trigger). It DROPS skill's `skill_name`/`trigger_text` and
ADDS `repo` (the scoping dimension) + `summary` (the brief body).

Lifecycle: `active` -> `superseded` (a newer version replaces it) or `active` ->
`closed` (retired).

## "repo-scoped" = a new `repo` column

The other E2 objects are tenant-scoped only. project_brief adds a `repo TEXT NOT NULL`
column: a brief is keyed by `(tenant_id, repo)`. By convention there is ONE active
brief per `(tenant, repo)` (the supersede op is how you update it), but NO DB
uniqueness constraint - a partial-unique-active index would fire mid-supersede (the
INSERT-then-UPDATE pattern briefly has 2 active rows), consistent with every other
E2 object. `loadActiveBriefForRepo(tenant, repo)` returns the most-recent active
brief for the repo (`ORDER BY created_at DESC, id DESC LIMIT 1`) or null.

**Grill note - multiple active briefs per repo:** `brief new <repo>` does NOT refuse
when an active brief already exists for the repo (consistent with skill, where two
same-name skills can both be active). The convention is one-active-per-repo via the
supersede path; if an operator creates a second active brief, `loadActiveBriefForRepo`
and `refreshBrief` deterministically act on the MOST-RECENT active row. This is an
operator error the DB does not prevent (matching all E2 objects), documented not
guarded.

## The refresh assembler (the distinguishing deliverable)

Two functions, cleanly separated (pure renderer + the write op):

1. `assembleBriefFromReceipts(hippoRoot, tenantId, repo): string` - the PURE
   deterministic renderer. Gathers the repo's receipts and returns a markdown digest
   STRING (no side effects; testable in isolation). Always returns a non-empty,
   valid summary (a brief `summary` is NOT NULL), including the zero-receipts case.

   Receipt query (tenant-scoped, tag-filtered, capped, deterministic order):
   ```sql
   SELECT id, created, source, content FROM memories
   WHERE tenant_id = ? AND tags_json LIKE ? ESCAPE '\'
   ORDER BY created DESC, id DESC
   LIMIT ?
   ```
   The LIKE param is `%"path:<repo-lowercased>"%` (the tag is a JSON array element
   `"path:hippo"`). **`repo` is operator-supplied -> LIKE-escape `\`, `%`, `_`
   before interpolating into the pattern, and parameterize the value** (never string
   concatenation - security.md). Cap `MAX_BRIEF_RECEIPTS = 50`.

   Render (deterministic, no LLM):
   ```
   # Project Brief: <repo>

   _Auto-assembled from <N> receipt(s)._

   ## Recent receipts

   - <YYYY-MM-DD> [<source>] <first-line-of-content, newline-stripped, truncated to MAX_RECEIPT_HEADLINE_LEN>
   - ...
   ```
   Zero receipts -> the `## Recent receipts` section reads `_No receipts found for <repo>._`.

2. `refreshBrief(hippoRoot, tenantId, repo, actor): ProjectBrief` - the "auto-refresh"
   op. Calls `assembleBriefFromReceipts`, then `saveProjectBrief` superseding the
   repo's CURRENT active brief (via `loadActiveBriefForRepo`), or creating v1 if none
   exists. `change_summary` defaults to `auto-refresh from <N> receipts`; the
   supersede/create audit metadata carries `refreshed: true, receipt_count: N` so the
   audit trail distinguishes auto-refresh from a manual supersede WITHOUT needing a
   4th audit op (the 3-site lockstep stays at 3 ops).

   NOTE: refresh reads receipts then writes the brief in saveProjectBrief's SAVEPOINT.
   The assemble (read of memories) happens BEFORE writeEntry opens its savepoint;
   acceptable - a concurrent receipt write merely lands in the next refresh.

## Schema (migration v35)

`CURRENT_SCHEMA_VERSION` 34 -> 35. New `project_briefs` table = the v34 skills table
with `skill_name`/`trigger_text` replaced by `repo`/`summary`:

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `repo` TEXT NOT NULL  (the repo-scoping dimension)
- `summary` TEXT NOT NULL  (the brief body)
- `version` INTEGER NOT NULL DEFAULT 1
- `status` TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
- `superseded_by` INTEGER, FK -> project_briefs(id) ON DELETE SET NULL
- `superseded_at` TEXT
- `change_summary` TEXT
- `closed_at` TEXT
- `created_at` TEXT NOT NULL

**SQL reserved-word check (skill-episode lesson):** every column name checked against
SQLite keywords - `repo`, `summary`, `version`, `status`, `change_summary`,
`closed_at`, `created_at`, `superseded_by/_at`, `memory_id`, `tenant_id` are all
NON-reserved. No `trigger`-class collision.

Indexes: `idx_project_briefs_tenant_status` (tenant_id, status),
`idx_project_briefs_memory` (memory_id WHERE memory_id NOT NULL),
`idx_project_briefs_repo` (tenant_id, repo, status) for the per-repo active lookup.
Triggers (verbatim mirror, renamed): tenant-match INSERT + UPDATE (vs memory) +
supersede tenant-match UPDATE (self-FK). `if (!tableExists(...))` guarded.

## Validation / DoS caps

- `repo` required, trimmed, single-line (no newlines - it becomes a path tag + a
  heading), <= `MAX_REPO_LEN = 256`; `summary` required, <= `MAX_BRIEF_SUMMARY_LEN
  = 8192` (a body); `change_summary` <= 4096. Enforced at the store (throws) + HTTP
  boundary (400).
- `MAX_BRIEF_RECEIPTS = 50` (receipts gathered per refresh);
  `MAX_RECEIPT_HEADLINE_LEN = 200` (per-receipt headline truncation).

## Module `src/project-briefs.ts` (mirror skills.ts)

Exports: `BriefStatus`, `VALID_BRIEF_STATES`, `ProjectBrief` (incl `repo`, `summary`,
`version`, `changeSummary`, `supersededBy`), `SaveProjectBriefOpts` (`repo`,
`summary`, `changeSummary?`, `supersedesBriefId?`, `extraTags?`, internal
`refreshReceiptCount?`), `ListProjectBriefsOpts` (`status?`, `repo?`, `limit?`),
`saveProjectBrief`, `closeProjectBrief`, `loadProjectBriefById`, `loadProjectBriefs`,
`loadActiveBriefForRepo`, `assembleBriefFromReceipts`, `refreshBrief`,
`PROJECT_BRIEF_HALF_LIFE_DAYS` (in memory.ts = 90).

- `saveProjectBrief`: memory mirror (tags `['project_brief', ...extra]`, source
  'project_brief', confidence 'verified', layer Semantic, half_life
  PROJECT_BRIEF_HALF_LIFE_DAYS) + project_briefs row in the writeEntry SAVEPOINT.
  Supersede preflight (status='active' + version) BEFORE INSERT; CAS `id != newId`;
  server-derived version; change_summary. Emits `project_brief_create`
  (+ `project_brief_supersede`). Memory content = `repo\n\nsummary`.
- `closeProjectBrief(id)`: CAS active-only; `project_brief_close`.
- `loadProjectBriefs`: status + repo filters; reuse the limit-default pattern.
- Row<->domain maps are 1:1 (no reserved-word column rename needed).

## 3-site audit lockstep

`project_brief_create`, `project_brief_supersede`, `project_brief_close` in
audit.ts AuditOp union + cli.ts VALID_AUDIT_OPS + server.ts VALID_AUDIT_OPS. Pinned
by `tests/audit-ops-project-brief-lockstep.test.ts`. (refresh composes
create/supersede; no 4th op.)

## CLI / HTTP / SDK (mirror skills; reuse shared helpers)

- CLI `cmdProjectBrief` (keyword `brief`): `new <repo> --summary "<text>"` /
  `list [--status] [--repo]` / `get <id>` / `supersede <id> --summary "<text>"
  [--change]` / `close <id>` / `refresh <repo> [--dry-run]` (dry-run prints the
  assembled digest WITHOUT writing). Strict `parsePositiveBriefId` (`/^\d+$/`). No
  repeatable flags (all single-value; `--tag` already in the parseArgs allow-list if
  used).
- HTTP `/v1/project-briefs`: POST (new), GET (list + status + repo; **reuse the
  shared `parseListLimit`**), POST `/v1/project-briefs/refresh` (body `{repo,
  dryRun?}`; returns `{brief}` or `{markdown}` on dry-run; placed BEFORE the `/:id`
  routes), GET `/v1/project-briefs/:id`, POST `/v1/project-briefs/:id/supersede`,
  POST `/v1/project-briefs/:id/close`. DoS caps; 404/409 mapping. `/:id` matched by
  the digits-anchored regex `/^\/v1\/project-briefs\/(\d+)$/`.
- Python SDK: `ProjectBrief` model + `new_project_brief` / `supersede_project_brief`
  / `close_project_brief` / `list_project_briefs` / `get_project_brief` /
  `refresh_project_brief` (async + sync); `__init__` + BOTH `__all__` lists
  (models.py AND __init__.py - codex P3 carry-forward).

## Tests (real DB, no mocks)

- `tests/project-briefs-store.test.ts`: dual-write SAVEPOINT atomicity; supersede
  CAS + version chain + self-supersede preflight; close guard (active-only;
  cannot-close-superseded); not-found vs wrong-state; cross-tenant triggers (memory +
  supersede); ON DELETE SET NULL + old-version-loadable; status + repo filters;
  validation (missing repo/summary; caps; newline-in-repo rejected);
  `loadActiveBriefForRepo`; **assembleBriefFromReceipts** (gathers only the repo's
  path-tagged receipts, tenant-isolated, deterministic DESC order, headline
  truncation, LIKE-escape on a repo containing `%`/`_`, zero-receipts digest);
  **refreshBrief** (creates v1 when none; supersedes the active brief on a 2nd
  refresh; change_summary + refreshed metadata; dry-run path returns the string
  without writing).
- `tests/http-project-briefs.test.ts`: POST/GET/get/supersede/close + **POST
  /refresh** (writes) + **/refresh dryRun** (no write, returns markdown), auth gate,
  status + repo filter validation, cross-tenant isolation, DoS cap, fractional-limit
  400 (confirms the shared parseListLimit covers the new route).
- `tests/audit-ops-project-brief-lockstep.test.ts`: 3 ops in the 3 sites.
- `tests/project-brief-cli.test.ts`: `brief new <repo>` arg-shift (codex P2 class:
  the `new` keyword is not recorded as the repo); malformed-id rejected on
  close/supersede; new->supersede version chain; `brief refresh` assembles + writes;
  `refresh --dry-run` prints without writing.
- `python/tests/test_project_briefs.py`: Pydantic round-trip + SDK method presence +
  both __all__ contain ProjectBrief.
- **Schema-version bump**: 20 assertion sites 34 -> 35 (18x `.toBe(34)` across 8
  files + 2x `'34'` string in db-migration-v27-self-heal; grep-verified; binary-mode
  script; physics `toBe(32)` untouched; `toBe(getCurrentSchemaVersion())` sites
  auto-follow).

## Steps (each verify-checked)

1. db.ts: CURRENT_SCHEMA_VERSION 34->35 + v35 project_briefs migration.
2. src/memory.ts PROJECT_BRIEF_HALF_LIFE_DAYS=90; src/project-briefs.ts module +
   assembleBriefFromReceipts + refreshBrief.
3. audit.ts/cli.ts/server.ts: 3 ops lockstep.
4. CLI cmdProjectBrief + dispatch + help + examples.
5. HTTP /v1/project-briefs routes (incl /refresh, reuse parseListLimit).
6. Python SDK ProjectBrief + 6 methods + both __all__.
7. CHANGELOG Unreleased entry (em-dash-free).
8. 20 schema-version assertions 34->35; grep-confirm zero schema `.toBe(34)` remain.
9. Full build + vitest + pytest green.

## Risks & mitigations

- LIKE injection / wildcard via operator `repo`: parameterized query + escape
  `\`/`%`/`_`; `repo` single-line validated.
- "auto-refresh" scope creep: v1 is a deterministic assembler; LLM prose + async
  on-write + scheduler explicitly DEFERRED. Don't build a daemon.
- assemble determinism: ORDER BY created DESC, id DESC + capped; test the rendered
  string.
- SQL reserved word (skill lesson): all column names checked; none reserved.
- Self-supersede / dual-write: skill preflight + CAS verbatim.
- Sibling-clone (audit rule 8): REUSE parseListLimit; refreshBrief is genuinely-new
  code (the receipt query), reviewed fresh.
- models.__all__ AND __init__.__all__ both updated (codex P3).
- Schema-version drift: 20 sites; grep-confirm post-bump.
- Line endings: targeted Edits (repo uniformly LF).
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope (noted)

- LLM prose summarization of receipts (the deterministic assembler is the seam a
  future LLM layer plugs into): future.
- Async auto-refresh on every repo write + staleness tracking + a scheduler: future.
- Writing the brief into a repo file (e.g. BRIEF.md): future (refresh returns/stores
  the body; file-write is a separate operator action, like skill's export).
- DB name-uniqueness on (tenant, repo): future (supersede is the update path).
- Cross-repo / multi-repo briefs, receipt filtering by kind/source: future.
