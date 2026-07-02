# Memory scope isolation (ROADMAP.md Part I [Committed], added c7c7fdf)

2026-07-01, v2 after codex plan review (REJECT on v1; 5 P1 + 13 P2 findings applied; see "Review deltas" at bottom). Target: next minor (v1.24.0). Branch: `feat/memory-scope-isolation` (worktree `hippo-wt-scope-isolation`).

## Problem

The every-turn UserPromptSubmit hook (`hippo context --pinned-only --include-recent 5 --format additional-context`, src/hooks.ts:118) injects memories from other projects into the active session. Reproduced 2026-07-01 from `C:\Users\skf_s\shiny` (own `.hippo` store): 19/19 injected entries were `[global]`-store rows about other projects. Observed 2026-06-30: a production API key stored as a memory in the live context of unrelated sessions; a wrong-project infra recommendation traced to the same bleed.

## Root cause

1. **`getContext` (src/api.ts:2118) bypasses the scope-isolation machinery `api.recall` enforces** (`passesScopeFilterForRecall` api.ts:182-198, `RECALL_DEFAULT_DENY_SCOPES` store.ts:227 via `loadRecallSearchEntries`). Its loads (`loadAllEntries` api.ts:2143-2144; pinned mode api.ts:2176+) apply no scope predicate.
2. **No project-origin partition anywhere.** Global rows (`~/.hippo`) merge into every session (searchBoth shared.ts:88-143, searchBothHybrid shared.ts:170-227); origin is recorded only lossily (`source: shared:<project>:<ts>`, from a path basename, shared.ts:278-305) and never consulted. `autoShare` (shared.ts:373-411) only down-weights `api-key`-tagged rows (PROJECT_SPECIFIC_TAGS -0.15), never vetoes.
3. **No secret detection on memory content** (only provider-error redaction and sleep metadata redaction).
4. Path identity is a weak rank-boost only (`pathOverlapScore` path-context.ts:29-37 divides by the memory's tag count; bare `path:skf_s` scores 1.0 everywhere under home) - but path tuning is DEFERRED (see Non-goals) because it lives in generic search code.

## Design pillars

### Origin model (three-valued, default-deny for unknowns)

New column `memories.origin_project TEXT NULL`:
- `'<name>'` - owned by that project (lowercased project-root basename from `resolveProjectIdentity`).
- `''` - explicitly user-global (written at/under home or in a markerless dir; injectable everywhere).
- `NULL` - legacy/unknown - **treated as OTHER-PROJECT (deny) by ambient context**, never as trusted. (codex P1-1: NULL-injects would invert default-deny.)

Write sites always stamp `''` or a name going forward; NULL only exists pre-migration.

**Backfill (migration, evidence-based only - codex P2-7; no path-tag guessing):**
- Rows in a PROJECT-local store: origin = that store's project name (`resolveProjectIdentity(storeRoot)`) - store location is authoritative.
- Rows in the global/home store with parseable `source: shared:<project>:<ts>`: origin = `<project>`.
- Remaining global/home-store rows (written at home): origin = `''` (user-global). Rationale: home-store rows ARE the user's global working set; the secret veto (below) backstops keys among them. This is store-location evidence, not a guess.
- Anything else stays NULL (deny).

### Surface policy matrix (codex P2-9)

| Surface | Origin partition | Secret veto |
|---|---|---|
| `getContext` all 3 modes (pinned / `*` / query) - feeds CLI `hippo context`, hook inject | ON (default) | ON (always) |
| CLI context render + ambient-state summary (cli.ts:5463-5474 recomputes from raw loads - must use filtered set, codex P2-13) | ON | ON |
| MCP `hippo_context` (does NOT call getContext today, mcp/server.ts:974-1004 - route through `api.getContext` or apply identical policy, codex P2-12) | ON | ON |
| HTTP `GET /v1/context` (server.ts:1032-1077) | ON (opt-out via `cross_project=true` param) | ON |
| `api.recall` / MCP `hippo_recall` / HTTP recall / CLI `hippo recall` | OFF - recall is a deliberate act | OFF (recallable explicitly) |
| `autoShare` / `shareMemory` (to global) | n/a | **hard veto pre-transferScore** |
| `syncGlobalToLocal` (shared.ts:418-436) | ON - only same-project + `''` rows copy down; preserves origin_project on the copy | ON (secret rows never sync) |

Escape hatches: `ContextOpts.crossProject` -> CLI `hippo context --cross-project` -> HTTP `cross_project` param; config `contextProjectIsolation: false` restores legacy behavior wholesale (threaded through config.ts defaults; codex P2-10/P2-11).

Known residue (tracked in TODOS.md, NOT this PR): CLI `hippo recall` direct path (cli.ts:901-902 via searchBoth) predates api.recall's private-scope SQL default-deny; unchanged here (codex P1-3 resolved as documented follow-up since recall is deliberate by policy).

## Slices

### S1. Project identity + origin persistence

- `src/project-identity.ts` (DONE, cycle-free leaf module): `resolveProjectIdentity(cwd)` -> `{root, name, isHome}`; nearest `.hippo` else `.git` (dir or worktree file); home is never a project (its `.hippo` is the global store); markerless => user-global (`name: ''`); realpath/junction-safe; cached. `deriveOriginProject(cwd)` -> `'<name>' | ''`.
- Persistence threading (codex P1-5, ALL sites): `MemoryEntry.origin_project` (memory.ts), `MemoryRow` + `MEMORY_SELECT_COLUMNS` + `rowToEntry` + upsert/writeEntry (store.ts), markdown-mirror `serializeEntry`/`deserializeEntry` frontmatter, createMemory/remember write sites (cli.ts ~12 sites via one helper), `shareMemory` stamps canonical origin via `resolveProjectIdentity` not path basename (codex P2-17). FTS projection untouched (origin is not searchable text). Migration = next schema version, additive column + backfill above; per-version migration test with real pre-migration rows. (ROADMAP "Iron rule" concerns NEW TABLES; this is an additive column - risk framing is projection coverage, codex P2-6.)

### S2. Envelope-filter parity inside getContext ONLY

Apply `passesScopeFilterForRecall` + `RECALL_DEFAULT_DENY_SCOPES` as a post-load filter on getContext's candidate sets (all 3 modes), leaving `loadAllEntries`/`searchBoth*` untouched so `hippo recall`'s public behavior cannot shift (codex P1-2). `--scope` callers keep recall-parity semantics.

### S3. Origin partition + crossProject threading

- Partition in getContext per the matrix; `ContextResultEntry` gains `origin: string | null` + `category: 'project' | 'user-global' | 'cross-project'` so the renderer and tests can see why an entry appeared (codex P2-15).
- CLI: `--cross-project` flag; excluded-by-default entries render under `## Other-project memory (explicitly requested)` only when requested; snapshot tests updated.
- HTTP `/v1/context`: `cross_project` query param, documented, default off.
- MCP `hippo_context`: route through `api.getContext` (preferred; fall back to identical inline policy if routing is structurally hard - decide at implementation with a note).
- Ambient-state summary computed from the FILTERED entry set.
- `syncGlobalToLocal`: origin-gated, preserves origin, skips secrets.

### S4. Secret hard rule (producer + consumer)

`src/secret-detect.ts`: `detectSecret(entry) -> { flagged: boolean, reason: string | null }` combining:
- Tag veto: `secret`, `api-key`, `credential`, `token`, `password`.
- Provider-bounded content patterns ONLY (codex P2-8, no bare `sk-` prose trap): `AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{36}` / `gho_` / `github_pat_`, `xox[baprs]-[A-Za-z0-9-]{10,}`, `sk-[A-Za-z0-9]{20,}` bounded by non-word delimiters AND co-occurring with key-ish nouns (key|token|secret|api) within the same line, `sk_(live|test)_[A-Za-z0-9]{16,}`, `AIza[0-9A-Za-z_-]{35}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`, generic assignment `(api[_-]?key|secret|token|password)\s*[:=]\s*[^\s'"]{12,}`.
- Producer: `autoShare`/`shareMemory` hard-veto flagged rows BEFORE transferScore; skip count in SleepResult + sleep output line.
- Consumer: ambient surfaces (matrix) never emit flagged rows outside their owning project; flagged rows with origin `''`/NULL never ambient-inject anywhere. Explicit recall unaffected.
- Tests include benign-prose negatives ("the ghp_ prefix identifies GitHub tokens", "risk-free rate", markdown code fences) and true-positive fixtures.

## Non-goals

- **S5 path-overlap tuning - DEFERRED** to a follow-up under a fuller retrieval eval (codex P2-16/P3-20): the boost lives in generic search code shared with recall; isolate + measure separately.
- A4 full lifecycle compliance (write-time scrubbing, PII, right-to-be-forgotten).
- A5 sub-2 L9 background-pipeline tenant scoping.
- CLI `hippo recall` private-scope residue (TODOS.md follow-up).
- Changing the hook command or any consumer integration. NOTE for CHANGELOG (codex P2-18): installed hooks keep working unchanged; their injected content just gets project-scoped - call this out prominently as intended behavior change with the `contextProjectIsolation: false` opt-out.

## Tests (real SQLite, no mocks)

- S1: project-identity unit tests (DONE, 14 cases incl. junction + home/.hippo-global trap); migration up test on real pre-migration rows covering all four backfill buckets; mirror round-trip preserves origin.
- S2: private-scope + `unknown:legacy` rows excluded from all 3 getContext modes for a no-scope caller.
- S3: **the leak test the current suite cannot catch (codex P2-14)**: two project stores + an INITIALIZED global store under a test `HIPPO_HOME`; project-B-origin rows (incl. pinned) absent from project-A context in pinned/recent/query/`*` modes; present under `--cross-project` with the demarcated header; `''`-origin rows present everywhere; NULL-origin rows absent by default; full-legacy parity with `contextProjectIsolation: false`. Same assertions through HTTP `/v1/context` and MCP `hippo_context`. syncGlobalToLocal gating tests.
- S4: producer (sleep never shares flagged rows; SleepResult count) + consumer (flagged row never ambient-injects outside owner; explicit recall still returns it) + benign-prose negatives.
- CLI snapshot tests updated; ambient-summary test asserts it reflects the filtered set.

## Risks

- Legacy NULL-deny may hide a wanted memory until re-written/confirmed -> escape hatches + backfill buckets minimize; secret veto backstops the home bucket.
- Migration threading breadth (P1-5) -> single helper for write sites; per-site grep audit at review (from-import, sys.path-style dynamic surfaces).
- Concurrent multi-agent repo activity -> dedicated worktree (done), `git branch --show-current` before every commit, check origin/master before version bump.

## Process

Implement S1 -> S4 in order, tests green per slice -> codex gating review per commit (`codex review`, Windows: `-c "mcp_servers={}"`, stdin closed, cwd-pinned) -> PR -> squash merge -> `npm run build:all` -> v1.24.0.

## Review deltas (v1 -> v2, codex 2026-07-01)

P1-1 NULL=deny origin model; P1-2 filter inside getContext, no shared-loader swap; P1-3 CLI-recall surface documented as deliberate + TODOS residue; P1-4 syncGlobalToLocal gated; P1-5 full persistence threading enumerated; P2-6 Iron-rule framing fixed; P2-7 evidence-only backfill; P2-8 bounded secret patterns + negatives; P2-9 policy matrix; P2-10/11 crossProject threaded CLI/HTTP/config; P2-12 MCP context routed; P2-13 ambient summary filtered; P2-14 HIPPO_HOME leak tests; P2-15 ContextResultEntry origin/category; P2-16+P3-20 S5 deferred; P2-17 shareMemory canonical origin; P2-18 hook back-compat CHANGELOG note; P3-19 citations refreshed.
