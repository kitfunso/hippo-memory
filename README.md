# 🦛 Hippo

**The secret to good memory isn't remembering more. It's knowing what to forget.**

[![npm](https://img.shields.io/npm/v/hippo-memory)](https://npmjs.com/package/hippo-memory)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A memory layer for AI agents. Modeled on the hippocampus. Decay by default, strength through use, provenance on every memory. SQLite under the hood, zero runtime deps, works with every CLI agent you have.

```bash
npm install -g hippo-memory && hippo init --scan ~
```

One command. Every git repo on your machine gets memory.

```
Works with:    Claude Code, Codex, Cursor, OpenClaw, OpenCode, Pi, any MCP client
Imports from:  ChatGPT, Claude (CLAUDE.md), Cursor (.cursorrules), Slack, markdown
Storage:       SQLite backbone with markdown mirrors. Git-trackable, human-readable.
Dependencies:  Zero runtime deps. Node.js 22.5+. Optional embeddings via @xenova/transformers.
```

---

## Why this exists

Most "AI memory" systems save everything and search later. That's storage with semantic search bolted on. It's why your agent kept hitting the same deploy bug last week. And the week before. The system saw the failure four times. It had no way to know it should remember.

Hippo applies the thing brains have been getting right for 500 million years. Memories decay over time. Retrieval makes them stronger. Three biological layers (buffer, episodic, semantic) consolidate during sleep. Hard lessons stick because you used them. Trivia fades because you didn't.

It also fixes the portability problem. Your ChatGPT memories don't travel to Claude. Your `.cursorrules` don't travel to Codex. Hippo is one process behind every agent. CLAUDE.md, Cursor rules, ChatGPT exports, Slack history, all in one SQLite store, all queryable from any tool that speaks MCP or HTTP.

---

## Receipts

Numbers, not adjectives. Every claim links to the benchmark or the test that proves it.

- **78% → 14% trap rate.** [Sequential Learning Benchmark](benchmarks/sequential-learning/). 50 tasks, 10 buried traps. Measures whether agents actually learn from past mistakes, not just retrieve text.
- **R@5 = 74.0%** on [LongMemEval](benchmarks/longmemeval/). 500-question industry retrieval benchmark, BM25 only, no embeddings.
- **10 of 10 incident scenarios beat transcript replay** on a staged Slack corpus ([benchmarks/e1.3/](benchmarks/e1.3/)). Recall surfaces the cause faster than scrolling the last N messages.
- **0 outbound HTTP** on the 1000-event ingestion smoke. Proven by a `globalThis.fetch` spy that throws on call, not a hardcoded zero.
- **926 tests, real DB, zero mocks.** Project rule. The one mocks-vs-prod divergence that bit us early is now the constraint that kept the next ten releases honest.
- **dlPFC goal-conditioned cluster discrimination, 3/3 queries pass** — full goal stack with policy weighting and lifespan-windowed outcome propagation. Per-goal lift on a 3-cluster fixture where BM25 alone cannot discriminate; deterministic test in [`benchmarks/micro/results/b3-depth.json`](benchmarks/micro/results/b3-depth.json).

---

## What it does for your agent

- **Stops repeating mistakes.** Tag a failure with `--tag error` once, the lesson surfaces every time the agent walks back into that part of the code. Errors decay slower than ordinary observations.
- **Survives tool switches.** Use Claude Code on Monday, Cursor on Tuesday, Codex on Wednesday. Same `.hippo/` store. Same memories. Pick up exactly where you left off.
- **Ingests systems of record.** Slack today (`POST /v1/connectors/slack/events`). GitHub, Jira, Notion next. Webhooks land as `kind='raw'` memories with full provenance and GDPR-correct deletion.
- **Knows where every memory came from.** Every row carries `kind`, `scope`, `owner`, and `artifact_ref`. Right-to-be-forgotten is a single API call, not an audit nightmare.
- **Plays nice with multi-tenant.** API keys, scrypt-hashed. Audit log on every mutation. Tenant A literally cannot see tenant B's memories. Proven by negative test.

---

## Quick start

```bash
npm install -g hippo-memory

# Single project
hippo init

# All your projects at once (recommended)
hippo init --scan ~
```

`--scan` finds every git repo under your home directory, creates a `.hippo/` store in each one, and seeds it with lessons from the last 30 days of commit history. One command, instant memory across all your projects.

After setup, `hippo sleep` runs at session end (via auto-installed agent hooks) and does five things:

1. **Learns** from today's git commits
2. **Imports** new entries from Claude Code MEMORY.md files
3. **Consolidates** memories (decay, merge, prune)
4. **Deduplicates** near-identical memories, keeping the stronger copy
5. **Shares** high-value lessons to a global store so they surface in every project

```bash
# Manual usage
hippo remember "FRED cache silently dropped the tips_10y series" --tag error
hippo recall "data pipeline issues" --budget 2000
```

---

### What's new in v1.5.0

- **DAG-aware recall.** When a query's matched leaves overflow the result limit and ≥2 of them share a level-2 parent summary, recall appends the summary so you see a compact pointer to the missing detail instead of silently dropping it. Capped at ceil(limit * 0.3) extras so a runaway DAG can't bloat results. Tenant-scoped, scope-filtered, opt-out via `summarizeOverflow: false`.
- **`hippo drill <summary-id>`.** Companion command. Walks one step down the DAG from a level-2 summary to its direct children. `--limit N` and `--budget N` options for budgeted recovery. JSON output via `--json`.
- **Schema v25** caches `descendant_count`, `earliest_at`, `latest_at` on summary rows. Idempotent ALTER + backfill on existing v24 DBs; no `min_compatible_binary` bump.
- **Lifted from [lossless-claw](https://github.com/Martian-Engineering/lossless-claw)** (LCM paper, Voltropy / Martian Engineering): depth-stratified summaries + drill-down. Adapted to Hippo's score-ranked recall instead of conversation-order assembly. Phase 2 (context-engine assembler) and Phase 3 (sub-agent expansion) on the roadmap.
- 1256 tests passing (+19 from v1.4.0).

### What's new in v1.4.0

- **First repo-level CI workflow + provenance gate enforced on every PR.** `.github/workflows/ci.yml` runs build + 1237 vitest cases + a CI-only seed that ingests one GitHub webhook + one Slack message through the real connectors then runs `hippo provenance --strict`. Drop a connector's owner stamp and the PR fails. Read-only permissions, 25-minute timeout, uploads `provenance-coverage.json` as a workflow artifact.
- **Slack `bot_message` provenance gap closed.** `slack/transform.ts` shipped `owner: undefined` for userless bot messages, which would have failed any future strict gate. Now derives `owner: bot:<bot_id>` (or `bot:unknown` as a sentinel). Skipping userless messages was rejected during plan review because `slack/ingest.ts:54-65` would have silently dropped existing bot ingestion via the "skipped but seen" path.
- **`SlackMessageEvent.bot_id` added** as an optional field on the public type.
- **Slack provenance parity test** mirrors `tests/github-provenance-parity.test.ts` and covers user, `bot_message`, threaded replies, and `message_changed` edits.

### What's new in v1.3.2

- **Hotfix for v1.3.1.** Codex round 3 + senior code reviewer caught residual bugs in v1.3.1's own fix.
- **Deletion idempotency uses a `deleted:` namespace** so it doesn't collide with the ingest path's key for the same artifact. v1.3.1 made them share a key (the obvious fix), which broke the deletion path: every first-deletion-of-an-ingested-comment short-circuited as `'duplicate'`. v1.3.2 splits the namespaces.
- **DLQ replay routes deleted comments correctly.** v1.3.1 wrote replayed `*.deleted` rows as fresh raw memories; v1.3.2 dispatches to the deletion handler.
- **`compareSemver` is loud on pre-release tags** instead of silently miscomparing `1.3.2-beta` as less than `1.3.2`. Defends the rollback guard.
- **`IngestHook` type cleaned up** — phantom `idempotencyKey` arg removed.

### What's new in v1.3.1

- **Hotfix for v1.3.0.** Retroactive `/codex review` (round 2) + `/review` (senior code reviewer) caught 3 P0s and 6 P1s the plan-only review missed. All addressed.
- **Rollback guard is now actually enforced.** Older binaries opening a v1.3-migrated DB throw on open instead of silently leaking private rows.
- **Multi-row comment deletion is atomic.** Edit histories archive in one transaction; any failure rolls back the whole batch and leaves idempotency unset for retry.
- **Backfill and webhook share an idempotency key.** Same source revision delivered via either path collapses to one memory row. Key derives from `sha256(artifact_ref + ':' + updated_at)` instead of `sha256(eventName + ':' + rawBody)`.
- **DLQ replay actually replays** instead of being a dry-run that printed "replay ok". Plus `GITHUB_WEBHOOK_SECRET_PREVIOUS` support and proper HTTP/MCP version reporting.

### What's new in v1.3.0

- **GitHub connector.** Stream issues, issue comments, PRs, and PR review comments into hippo as `kind='raw'` rows. Webhook route at `POST /v1/connectors/github/events` (HMAC-verified). CLI: `hippo github backfill --repo <owner/name>`, `hippo github dlq list`, `hippo github dlq replay <id>`. Required env: `GITHUB_WEBHOOK_SECRET` (route), `GITHUB_TOKEN` (backfill).
- **Replay-safe idempotency.** Keyed on `sha256(eventName + ':' + rawBody)`, not `X-GitHub-Delivery` (which GitHub does not sign). Attackers cannot bypass dedupe by minting fresh delivery UUIDs.
- **Three-stream backfill.** Issues, issue comments, PR review comments each have their own high-water mark. A crash mid-stream-2 leaves stream-1's HWM intact and stream-2's HWM unchanged so resume is safe and idempotent.
- **PAT and App tenant routing.** `github_installations` for App webhooks; `github_repositories` for PAT-mode multi-tenant. Fail-closed: an unknown installation in a multi-tenant install routes to the DLQ rather than to `HIPPO_TENANT`.
- **Schema v24** with rollback safety. The migration writes `meta.min_compatible_binary='1.2.1'` so older binaries refuse to open the DB and cannot leak private rows.
- 1214 tests passing. Independent codex audit on the plan caught 5 P0 and 8 P1 issues before coding began; all addressed.

### What's new in v1.2.1

- **Source-agnostic default-deny.** The v1.2 filter only blocked `slack:private:*`. v1.2.1 generalizes to ANY `<source>:private:*` scope so the v1.3 GitHub connector (and future Jira/Linear/etc.) cannot leak private rows to no-scope callers. Single source of truth via the new `isPrivateScope` export.
- **Pre-flight for v1.3.** Codex audit on the v1.3 plan flagged this as a P0 to fix BEFORE any GitHub work began, so rollback after v1.3 ships stays safe.
- **No behavior change for existing users.** Public scopes, null scope, and exact-match queries are unchanged. Only no-scope callers facing a private row from any future connector see different behavior (which is the entire point).

### What's new in v1.2.0

- **Continuity exposed everywhere.** MCP `hippo_recall` accepts `include_continuity: true`, HTTP `GET /v1/memories` accepts `?include_continuity=1`. CLI `--continuity` shipped in v1.1.
- **Scope filter, end-to-end.** `api.recall`, `cmdRecall`, MCP `hippo_recall`, MCP `hippo_context`, and HTTP `GET /v1/memories` all enforce the same rule: explicit scope = exact match, no scope = default-deny on `slack:private:*` and quarantined legacy rows.
- **Schema v23.** `task_snapshots` gains `scope`. Pre-existing rows with NULL scope are quarantined as `'unknown:legacy'` so they default-deny.
- **Closes v1.0.0 + v1.1.0 known limitations.** Continuity tables no longer carry NULL scope as a load-bearing data state. The "Deferred to v1.2.0" line is gone.
- **Security note.** Codex review caught two real issues that this release fixes: (1) v1.1's "explicit scope" actually meant "allow all" (latent leak), now exact-match; (2) `loadLatestHandoff` SELECTs were missing scope, would have leaked private handoffs to no-scope callers post-writers.

### What's new in v1.1.0

- **Continuity-first recall.** `api.recall` accepts `includeContinuity: true` to return the active task snapshot, latest matching session handoff, and last 5 session events alongside the ranked memories. One call, agent boot ready. CLI: `hippo recall <query> --continuity`.
- **Anchored, no resurrection.** Continuity is anchored to the active snapshot's session_id. No anchor = no handoff/events. The explicit handoff-without-snapshot path is still `hippo session resume`.
- **Hot path unchanged.** Default-off everywhere. Existing recall callers see no behavior change.
- **Deferred to v1.2.0.** MCP `hippo_recall` continuity and HTTP `GET /v1/memories?include_continuity=true` ship together with the `scope` read-side filter on continuity tables.

### What's new in v1.0.0

- **Tenant-isolation security release.** v0.40.0's measurement gates surfaced a real cross-tenant data leak on the continuity tables (`task_snapshots`, `session_events`, `session_handoffs`). Schema migration v22 closes the gap: every continuity helper now scopes reads and writes by `tenantId`. Markdown mirror files (`buffer/active-task.md`, `buffer/recent-session.md`) are tenant-scoped too; the default tenant keeps the unsuffixed filename for on-disk back-compat.
- **Slack envelope fix.** `messageToRememberOpts` now sets `owner: 'user:<slack_user_id>'` so ingested Slack rows pass the v0.40.0 `hippo provenance --strict` gate.
- **Breaking change for JS callers.** 10 store helpers (`saveActiveTaskSnapshot`, `loadLatestHandoff`, `appendSessionEvent`, etc.) gained a required `tenantId` second argument. TypeScript callers get a compile error. JS callers get a runtime guard error (`assertTenantId`) that detects the most common misbinding (passing a `sess-*` session id) and points at the migration. See CHANGELOG for the full helper list.
- **Schema v22 migration.** Idempotent, transactional, with smart tenant backfill via unambiguous `task_snapshots.session_id` joins.

### What's new in v0.40.0

- **Company Brain measurement gates.** Two new diagnostic commands close the last blocked rows of the Company Brain scorecard. `hippo provenance [--json] [--strict]` audits every `kind='raw'` row for `owner` + `artifact_ref`; `--strict` exits non-zero so CI can block on coverage regressions. `hippo correction-latency [--json]` reports p50 / p95 / max wall-clock lag from receipt to supersession across `superseded_by` chains. Both helpers (`buildProvenanceCoverage`, `buildCorrectionLatency`) are importable from `src/`.
- **No behavioral change to remember / recall.** Additive only: schema unchanged, retrieval untouched.

### What's new in v0.39.0

- Security hardening release: 5 CRITICAL cross-tenant fixes (CVE candidates), GDPR Path A on archive (true RTBF), MCP per-client isolation, Slack ingestion race + idempotency hardening, auth timing leak reduction.

### What's new in v0.38.0

- **B3 dlPFC persistent goal stack (depth 3).** Schema v18 adds `goal_stack`, `retrieval_policy`, `goal_recall_log`. New CLI subcommands: `hippo goal push|list|complete|suspend|resume`. With `HIPPO_SESSION_ID` set, `hippo recall` auto-boosts memories tagged with the active goal (final multiplier hard-capped at 3.0x). Retrieval policies (`error-prioritized`, `schema-fit-biased`, `recency-first`, `hybrid`) further shape ranking.
- **Outcome propagation with lifespan window.** `hippo goal complete --outcome <score>` adjusts strength only on memories actually recalled while the goal was alive. `outcome >= 0.7` boosts (×1.10), `outcome < 0.3` decays (×0.85), neutral band leaves strength alone. UNIQUE(memory_id, goal_id) prevents double-propagation.
- **B3 cluster-discrimination micro-benchmark.** `benchmarks/micro/fixtures/dlpfc_depth.json` — 3 disjoint memory clusters under 3 named goals. Each query asserts the active goal's cluster is in top-3 AND the other two clusters are NOT, a deterministic test BM25 alone cannot pass. Receipt: 3/3 queries pass in [`benchmarks/micro/results/b3-depth.json`](benchmarks/micro/results/b3-depth.json).
- **Deferred to v0.39:** sequential-learning trap-rate lift (needs adapter contract change), MCP/REST `session_id` plumbing, vlPFC interference handling, `--no-propagate` flag.

### What's new in v0.37.0

- **Slack ingestion (E1.3).** First end-to-end ingestion connector. `POST /v1/connectors/slack/events` accepts HMAC-signed Events API webhooks; messages land as `kind='raw'` memories with `slack://team/channel/ts` provenance and a `slack:public:*` or `slack:private:*` scope. Source deletions route through `archiveRawMemory` (GDPR). Backfill via `hippo slack backfill --channel <id>`; malformed events to `hippo slack dlq list`.
- **Schema v17.** New tables: `slack_event_log` (idempotency), `slack_cursors` (backfill resume), `slack_dlq` (parse failures), `slack_workspaces` (team_id to tenant_id routing).
- **`PUBLIC_ROUTES` allow-list + `HIPPO_REQUIRE_AUTH` knob.** The Slack webhook is the first explicit public `/v1/*` route (HMAC-signed, no Bearer). Every other `/v1/*` route returns 401 without auth when `HIPPO_REQUIRE_AUTH=1`.
- **Recall default-deny on private scopes.** No-scope queries cannot see `slack:private:*` memories. Frontend callers passing undefined scope no longer leak private content.
- **`api.remember.afterWrite` hook.** Connectors stamp idempotency rows atomically with the memory row via a SAVEPOINT-scoped callback.

For everything since v0.8.0, see [CHANGELOG.md](./CHANGELOG.md).


### Zero-config agent integration

`hippo init` auto-detects your agent framework and wires itself in:

```bash
cd my-project
hippo init

# Initialized Hippo at /my-project
#    Directories: buffer/ episodic/ semantic/ conflicts/
#    Auto-installed claude-code hook in CLAUDE.md
```

If you have a `CLAUDE.md`, it patches it. `AGENTS.md` for Codex/OpenClaw/OpenCode. `.cursorrules` for Cursor. For Codex, Hippo also wraps the detected launcher in place so `/exit` can consolidate memory without a manual PATH step. No manual `hook install` needed. Your agent starts using Hippo on its next session.

It also registers the current project in Hippo's workspace registry and installs one machine-level daily runner (6:15am). That runner sweeps every registered workspace, runs `hippo learn --git --days 1`, then `hippo sleep`. You get strict daily consolidation without creating one OS task per project.

To skip: `hippo init --no-hooks --no-schedule`

---

## Cross-Tool Import

Your memories shouldn't be locked inside one tool. Hippo pulls them in from anywhere.

```bash
# ChatGPT memory export
hippo import --chatgpt memories.json

# Claude's CLAUDE.md (skips existing hippo hook blocks)
hippo import --claude CLAUDE.md

# Cursor rules
hippo import --cursor .cursorrules

# Any markdown file (headings become tags)
hippo import --markdown MEMORY.md

# Any text file
hippo import --file notes.txt
```

All import commands support `--dry-run` (preview without writing), `--global` (write to `~/.hippo/`), and `--tag` (add extra tags). Duplicates are detected and skipped automatically.

### Conversation Capture

Extract memories from raw conversation text. No LLM needed: pattern-based heuristics find decisions, rules, errors, and preferences.

```bash
# Pipe a conversation in
cat session.log | hippo capture --stdin

# Or point at a file
hippo capture --file conversation.md

# Preview first
hippo capture --file conversation.md --dry-run
```

### Slack ingestion (E1.3)

Hippo accepts Slack Events API webhooks at `POST /v1/connectors/slack/events`. Configure `SLACK_SIGNING_SECRET` (validated on every request) and point Slack at `https://<your-host>/v1/connectors/slack/events`. Messages land as `kind='raw'` memories with `slack://team/channel/ts` provenance and a `slack:public:Cxxx` or `slack:private:Cxxx` scope. Source deletions are honored (GDPR).

Backfill an existing channel: `SLACK_BOT_TOKEN=xoxb-... hippo slack backfill --channel C0000`. Inspect malformed events: `hippo slack dlq list`.

Multi-workspace deployments populate `slack_workspaces (team_id, tenant_id)` to route events per tenant; single-workspace falls back to `HIPPO_TENANT`.

### Active task snapshots

Long-running work needs short-term continuity, not just long-term memory. Hippo can persist the current in-flight task so a later `continue` has something concrete to recover.

```bash
hippo snapshot save \
  --task "Ship SQLite backbone" \
  --summary "Tests/build/smoke are green, next slice is active-session recovery" \
  --next-step "Implement active snapshot retrieval in context output"

hippo snapshot show
hippo context --auto --budget 1500
hippo snapshot clear
```

`hippo context --auto` includes the active task snapshot before long-term memories, so agents get both the immediate thread and the deeper lessons.

### Session event trails

Manual snapshots are useful, but real work also needs a breadcrumb trail. Hippo can now store short session events and link them to the active snapshot so context output shows the latest steps, not just the last summary.

```bash
hippo session log \
  --id sess_20260326 \
  --task "Ship continuity" \
  --type progress \
  --content "Schema migration is done, next step is CLI wiring"

hippo snapshot save \
  --task "Ship continuity" \
  --summary "Structured session events are flowing" \
  --next-step "Surface them in framework hooks" \
  --session sess_20260326

hippo session show --id sess_20260326
hippo context --auto --budget 1500
```

Hippo mirrors the latest trail to `.hippo/buffer/recent-session.md` so you can inspect the short-term thread without opening SQLite.

### Session handoffs

When you're done for the day (or switching to another agent), create a handoff so the next session knows exactly where to pick up:

```bash
hippo handoff create \
  --summary "Finished schema migration, tests green" \
  --next "Wire handoff injection into context output" \
  --session sess_20260403 \
  --artifact src/db.ts

hippo handoff latest              # show the most recent handoff
hippo handoff show 3              # show a specific handoff by ID
hippo session resume              # re-inject latest handoff as context
```

### Working memory

Working memory is a bounded scratchpad for current-state notes. It's separate from long-term memory and gets cleared between sessions.

```bash
hippo wm push --scope repo \
  --content "Investigating flaky test in store.test.ts, line 42" \
  --importance 0.9

hippo wm read --scope repo        # show current working notes
hippo wm clear --scope repo       # wipe the scratchpad
hippo wm flush --scope repo       # flush on session end
```

The buffer holds a maximum of 20 entries per scope. When full, the lowest-importance entry is evicted.

### Explainable recall

See why a memory was returned:

```bash
hippo recall "data pipeline" --why --limit 5

# --- mem_a1b2c3 [episodic] [observed] [local] score=0.847
#     BM25: matched [data, pipeline]; cosine: 0.82
#     ...memory content...
```

---

## How It Works

Input enters the buffer. Important things get encoded into episodic memory. During "sleep," repeated episodes compress into semantic patterns. Weak memories decay and disappear.

```
New information
      |
      v
+-----------+
|  Buffer   |  Working memory. Current session only. No decay.
| (session) |
+-----+-----+
      |  encoded (tags, strength, half-life assigned)
      v
+-----------+
|  Episodic |  Timestamped memories. Decay by default.
|   Store   |  Retrieval strengthens. Errors stick longer.
+-----+-----+
      |  consolidation (hippo sleep)
      v
+-----------+
|  Semantic |  Compressed patterns. Stable. Schema-aware.
|   Store   |  Extracted from repeated episodes.
+-----------+

         hippo sleep: decay + replay + merge
```

---

## Key Features

### Decay by default

Every memory has a half-life. 7 days by default. Persistence is earned.

```bash
hippo remember "always check cache contents after refresh"
# stored with half_life: 7d, strength: 1.0

# 14 days later with no retrieval:
hippo inspect mem_a1b2c3
# strength: 0.25  (decayed by 2 half-lives)
# at risk of removal on next sleep
```

---

### Retrieval strengthens

Use it or lose it. Each recall boosts the half-life by 2 days.

```bash
hippo recall "cache issues"
# finds mem_a1b2c3, retrieval_count: 1 -> 2
# half_life extended: 7d -> 9d
# strength recalculated from retrieval timestamp

hippo recall "cache issues"   # again next week
# retrieval_count: 2 -> 3
# half_life: 9d -> 11d
# this memory is learning to survive
```

---

### Active invalidation

When you migrate from one tool to another, old memories about the replaced tool should die immediately. Hippo detects migration and breaking-change commits during `hippo learn --git` and actively weakens matching memories.

```bash
hippo learn --git
# feat: migrate from webpack to vite
#    Invalidated 3 memories referencing "webpack"
#    Learned: migrate from webpack to vite
```

You can also invalidate manually:

```bash
hippo invalidate "REST API" --reason "migrated to GraphQL"
# Invalidated 5 memories referencing "REST API".
```

---

### Architectural decisions

One-off decisions don't repeat, so they can't earn their keep through retrieval alone. `hippo decide` stores them with a 90-day half-life and verified confidence so they survive long enough to matter.

```bash
hippo decide "Use PostgreSQL for all new services" --context "JSONB support"
# Decision recorded: mem_a1b2c3

# Later, when the decision changes:
hippo decide "Use CockroachDB for global services" \
  --context "Need multi-region" \
  --supersedes mem_a1b2c3
# Superseded mem_a1b2c3 (half-life halved, marked stale)
# Decision recorded: mem_d4e5f6
```

---

### Error memories stick

Tag a memory as an error and it gets 2x the half-life automatically.

```bash
hippo remember "deployment failed: forgot to run migrations" --error
# half_life: 14d instead of 7d
# emotional_valence: negative
# strength formula applies 1.5x multiplier

# production incidents don't fade quietly
```

---

### Confidence tiers

Every memory carries a confidence level: `verified`, `observed`, `inferred`, or `stale`. This tells agents how much to trust what they're reading.

```bash
hippo remember "API rate limit is 100/min" --verified
hippo remember "deploy usually takes ~3 min" --observed
hippo remember "the flaky test might be a race condition" --inferred
```

When context is generated, confidence is shown inline:

```
[verified] API rate limit is 100/min per the docs
[observed] Deploy usually takes ~3 min
[inferred] The flaky test might be a race condition
```

Agents can see at a glance what's established fact vs. a pattern worth questioning.

Memories unretrieved for 30+ days are automatically marked `stale` during the next `hippo sleep`. If one gets recalled again, Hippo wakes it back up to `observed` so it can earn trust again instead of staying permanently stale.

### Conflict tracking

Hippo detects obvious contradictions between overlapping memories and keeps them visible instead of silently letting both masquerade as truth. Shared tags alone do not count; the statements themselves need to overlap in content.

```bash
hippo sleep       # refreshes open conflicts
hippo conflicts   # inspect them
```

Open conflicts are stored in SQLite, mirrored under `.hippo/conflicts/`, and linked back into each memory's `conflicts_with` field.

---

### Observation framing

Memories aren't presented as bare assertions. By default, Hippo frames them as observations with dates, so agents treat them as context rather than commands.

```bash
hippo context --framing observe   # default
# Output: "Previously observed (2026-03-10): deploy takes ~3 min"

hippo context --framing suggest
# Output: "Consider: deploy takes ~3 min"

hippo context --framing assert
# Output: "Deploy takes ~3 min"
```

Three modes: `observe` (default), `suggest`, `assert`. Choose based on how directive you want the memory to be.

---

### Sleep consolidation

Run `hippo sleep` and episodes compress into patterns.

```bash
hippo sleep

# Running consolidation...
#
# Results:
#    Active memories:    23
#    Removed (decayed):   4
#    Merged episodic:     6
#    New semantic:        2
```

Three or more related episodes get merged into a single semantic memory. The originals decay. The pattern survives.

---

### Outcome feedback

Did the recalled memories actually help? Tell Hippo. It tightens the feedback loop.

```bash
hippo recall "why is the gold model broken"
# ... you read the memories and fix the bug ...

hippo outcome --good
# Applied positive outcome to 3 memories
# reward factor increases, decay slows

hippo outcome --bad
# Applied negative outcome to 3 memories
# reward factor decreases, decay accelerates
```

Outcomes are cumulative. A memory with 5 positive outcomes and 0 negative has a reward factor of ~1.42, making its effective half-life 42% longer. A memory with 0 positive and 3 negative has a factor of ~0.63, decaying nearly twice as fast. Mixed outcomes converge toward neutral (1.0).

---

### Token budgets

Recall only what fits. No context stuffing.

```bash
# fits within Claude's 2K token window for task context
hippo recall "deployment checklist" --budget 2000

# need more for a big task
hippo recall "full project history" --budget 8000

# machine-readable for programmatic use
hippo recall "api errors" --budget 1000 --json
```

Results are ranked by `relevance * strength * recency`. The highest-signal memories fill the budget first.

---

### Auto-learn from git

Hippo can scan your commit history and extract lessons from fix/revert/bug commits automatically.

```bash
# Learn from the last 7 days of commits
hippo learn --git

# Learn from the last 30 days
hippo learn --git --days 30

# Scan multiple repos in one pass
hippo learn --git --repos "~/project-a,~/project-b,~/project-c"
```

The `--repos` flag accepts comma-separated paths. Hippo scans each repo's git log, extracts fix/revert/bug lessons, deduplicates against existing memories, and stores new ones. Pair with `hippo sleep` afterwards to consolidate.

Ideal for a weekly cron:

```bash
hippo learn --git --repos "~/repo1,~/repo2" --days 7
hippo sleep
```

---

### Watch mode

Wrap any command with `hippo watch` to auto-learn from failures:

```bash
hippo watch "npm run build"
# if it fails, Hippo captures the error automatically
# next time an agent asks about build issues, the memory is there
```

---

## CLI Reference

| Command | What it does |
|---------|-------------|
| `hippo init` | Create `.hippo/` + auto-install agent hooks |
| `hippo init --global` | Create global store at `~/.hippo/` |
| `hippo init --no-hooks` | Create `.hippo/` without auto-installing hooks |
| `hippo remember "<text>"` | Store a memory |
| `hippo remember "<text>" --tag <t>` | Store with tag (repeatable) |
| `hippo remember "<text>" --error` | Store as error (2x half-life) |
| `hippo remember "<text>" --pin` | Store with no decay |
| `hippo remember "<text>" --verified` | Set confidence: verified (default) |
| `hippo remember "<text>" --observed` | Set confidence: observed |
| `hippo remember "<text>" --inferred` | Set confidence: inferred |
| `hippo remember "<text>" --global` | Store in global `~/.hippo/` store |
| `hippo recall "<query>"` | Retrieve relevant memories (local + global) |
| `hippo recall "<query>" --budget <n>` | Recall within token limit (default: 4000) |
| `hippo recall "<query>" --limit <n>` | Cap result count |
| `hippo recall "<query>" --why` | Show match reasons and source buckets |
| `hippo recall "<query>" --json` | Output as JSON |
| `hippo context --auto` | Smart context injection (auto-detects task from git) |
| `hippo context "<query>" --budget <n>` | Context injection with explicit query (default: 1500) |
| `hippo context --limit <n>` | Cap memory count in context |
| `hippo context --budget 0` | Skip entirely (zero token cost) |
| `hippo context --framing <mode>` | Framing: observe (default), suggest, assert |
| `hippo context --format <fmt>` | Output format: markdown (default) or json |
| `hippo import --chatgpt <path>` | Import from ChatGPT memory export (JSON or txt) |
| `hippo import --claude <path>` | Import from CLAUDE.md or Claude memory.json |
| `hippo import --cursor <path>` | Import from .cursorrules or .cursor/rules |
| `hippo import --markdown <path>` | Import from structured markdown (headings -> tags) |
| `hippo import --file <path>` | Import from any text file |
| `hippo import --dry-run` | Preview import without writing |
| `hippo import --global` | Write imported memories to `~/.hippo/` |
| `hippo capture --stdin` | Extract memories from piped conversation text |
| `hippo capture --file <path>` | Extract memories from a file |
| `hippo capture --dry-run` | Preview extraction without writing |
| `hippo sleep` | Run consolidation (decay + merge + compress) |
| `hippo sleep --dry-run` | Preview consolidation without writing |
| `hippo status` | Memory health: counts, strengths, last sleep |
| `hippo outcome --good` | Strengthen last recalled memories |
| `hippo outcome --bad` | Weaken last recalled memories |
| `hippo outcome --id <id> --good` | Target a specific memory |
| `hippo inspect <id>` | Full detail on one memory |
| `hippo forget <id>` | Force remove a memory |
| `hippo embed` | Embed all memories for semantic search |
| `hippo embed --status` | Show embedding coverage |
| `hippo watch "<command>"` | Run command, auto-learn from failures |
| `hippo learn --git` | Scan recent git commits for lessons |
| `hippo learn --git --days <n>` | Scan N days back (default: 7) |
| `hippo learn --git --repos <paths>` | Scan multiple repos (comma-separated) |
| `hippo daily-runner` | Sweep registered workspaces and run daily learn+sleep |
| `hippo conflicts` | List detected open memory conflicts |
| `hippo conflicts --json` | Output conflicts as JSON |
| `hippo resolve <id>` | Show both conflicting memories for comparison |
| `hippo resolve <id> --keep <mem_id>` | Resolve: keep winner, weaken loser |
| `hippo resolve <id> --keep <mem_id> --forget` | Resolve: keep winner, delete loser |
| `hippo promote <id>` | Copy a local memory to the global store |
| `hippo share <id>` | Share with attribution + transfer scoring |
| `hippo share <id> --force` | Share even if transfer score is low |
| `hippo share --auto` | Auto-share all high-scoring memories |
| `hippo share --auto --dry-run` | Preview what would be shared |
| `hippo peers` | List projects contributing to global store |
| `hippo sync` | Pull global memories into local project |
| `hippo invalidate "<pattern>"` | Actively weaken memories matching an old pattern |
| `hippo invalidate "<pattern>" --reason "<why>"` | Include what replaced it |
| `hippo decide "<decision>"` | Record architectural decision (90-day half-life) |
| `hippo decide "<decision>" --context "<why>"` | Include reasoning |
| `hippo decide "<decision>" --supersedes <id>` | Supersede a previous decision |
| `hippo hook list` | Show available framework hooks |
| `hippo hook install <target>` | Install hook (claude-code also adds Stop hook for auto-sleep) |
| `hippo hook uninstall <target>` | Remove hook |
| `hippo handoff create --summary "..."` | Create a session handoff |
| `hippo handoff latest` | Show the most recent handoff |
| `hippo handoff show <id>` | Show a specific handoff by ID |
| `hippo session latest` | Show latest task snapshot + events |
| `hippo session resume` | Re-inject latest handoff as context |
| `hippo current show` | Compact current state (task + session events) |
| `hippo wm push --scope <s> --content "..."` | Push to working memory |
| `hippo wm read --scope <s>` | Read working memory entries |
| `hippo wm clear --scope <s>` | Clear working memory |
| `hippo wm flush --scope <s>` | Flush working memory (session end) |
| `hippo dashboard` | Open web dashboard at localhost:3333 |
| `hippo dashboard --port <n>` | Use custom port |
| `hippo mcp` | Start MCP server (stdio transport) |

---

## Framework Integrations

### Auto-install (recommended)

`hippo init` detects your agent framework and patches the right config file automatically:

| Framework | Detected by | Patches |
|-----------|------------|---------|
| Claude Code | `CLAUDE.md` or `.claude/settings.json` | `CLAUDE.md` + `SessionStart`/`SessionEnd` hooks in `settings.json` |
| Codex | `AGENTS.md` or `.codex` | `AGENTS.md` + automatic in-place Codex launcher wrapper |
| Cursor | `.cursorrules` or `.cursor/rules` | `.cursorrules` |
| OpenClaw | `.openclaw` or `AGENTS.md` | native OpenClaw plugin or `AGENTS.md` |
| OpenCode | `.opencode/` or `opencode.json` | `AGENTS.md` |

No extra commands needed. Just `hippo init` and your agent knows about Hippo.

### Manual install

If you prefer explicit control:

```bash
hippo hook install claude-code   # patches CLAUDE.md + adds SessionStart/SessionEnd + UserPromptSubmit hooks
hippo hook install codex         # optional repair/manual run: patches AGENTS.md + wraps the detected Codex launcher
hippo hook install cursor        # patches .cursorrules
hippo hook install openclaw      # patches AGENTS.md
hippo hook install opencode      # patches AGENTS.md
```

This adds a `<!-- hippo:start -->` ... `<!-- hippo:end -->` block that tells the agent to:
1. Run `hippo context --auto --budget 1500` at session start
2. Run `hippo remember "<lesson>" --error` on errors
3. Run `hippo outcome --good` on completion

For Claude Code, it also adds:
- a `SessionEnd` hook so `hippo sleep` runs automatically when the session exits
- a `SessionStart` hook that prints the previous session's consolidation output
- a `UserPromptSubmit` hook that re-injects pinned memories (`hippo remember <text> --pin`) into every turn's context — so invariants survive long sessions where Opus 4.7 might otherwise "forget" them. Budget: 500 tokens per turn, skipped entirely when no pinned memories exist. Opt out with `{"pinnedInject":{"enabled":false}}` in `.hippo/config.json`.

To remove: `hippo hook uninstall claude-code`

### What the hook adds (Claude Code example)

```markdown
## Project Memory (Hippo)

Before starting work, load relevant context:
hippo context --auto --budget 1500

When you hit an error or discover a gotcha:
hippo remember "<what went wrong and why>" --error

After completing work successfully:
hippo outcome --good
```

### MCP Server

For any MCP-compatible client (Cursor, Windsurf, Cline, Claude Desktop):

```bash
hippo mcp   # starts MCP server over stdio
```

Add to your MCP config (e.g. `.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hippo-memory": {
      "command": "hippo",
      "args": ["mcp"]
    }
  }
}
```

Exposes tools: `hippo_recall`, `hippo_remember`, `hippo_outcome`, `hippo_context`, `hippo_status`, `hippo_learn`, `hippo_wm_push`.

### OpenClaw Plugin

Native plugin with auto-context injection, workspace-aware memory lookup, and
tool hooks for auto-learn / auto-sleep. When `autoSleep` is enabled, the
OpenClaw plugin now launches `hippo sleep` in a detached background worker at
session end so the live session can exit immediately.

Query-time retrieval still uses the active workspace store plus the shared
global store. Daily consolidation comes from the machine-level runner that
`hippo init` / `hippo setup` installs.

```bash
openclaw plugins install hippo-memory
openclaw plugins enable hippo-memory
```

Plugin docs: [extensions/openclaw-plugin/](extensions/openclaw-plugin/). Integration guide: [integrations/openclaw.md](integrations/openclaw.md).

### Claude Code Plugin

Plugin with SessionStart/Stop hooks and error auto-capture. See [extensions/claude-code-plugin/](extensions/claude-code-plugin/).

Full integration details: [integrations/](integrations/)

---

## The Neuroscience

Hippo is modeled on seven properties of the human hippocampus. Not metaphorically. Literally.

**Why two stores?** The brain uses a fast hippocampal buffer + a slow neocortical store (Complementary Learning Systems theory, McClelland et al. 1995). If the neocortex learned fast, new information would overwrite old knowledge. The buffer absorbs new episodes; the neocortex extracts patterns over time.

**Why does decay help?** New neurons born in the dentate gyrus actively disrupt old memory traces (Frankland et al. 2013). This is adaptive: it reduces interference from outdated information. Forgetting isn't failure. It's maintenance.

**Why do errors stick?** The amygdala modulates hippocampal consolidation based on emotional significance. Fear and error signals boost encoding. Your first production incident is burned into memory. Your 200th uneventful deploy isn't.

**Why does retrieval strengthen?** Recalled memories undergo "reconsolidation" (Nader et al. 2000). The act of retrieval destabilizes the trace, then re-encodes it stronger. This is the testing effect. Hippo implements it mechanically via the half-life extension on recall.

**Why does sleep consolidate?** During sleep, the hippocampus replays compressed versions of recent episodes and "teaches" the neocortex by repeatedly activating the same patterns. Hippo's `sleep` command runs this as a deliberate consolidation pass.

The 7 mechanisms in full: [PLAN.md#core-principles](PLAN.md#core-principles)

For how these mechanisms connect to LLM training, continual learning, and open research problems: **[RESEARCH.md](RESEARCH.md)**

**Why does reward modulate decay?** In spiking neural networks, reward-modulated STDP strengthens synapses that contribute to positive outcomes and weakens those that don't. Hippo's reward-proportional decay (v0.11.0) implements this: memories with consistent positive outcomes decay slower, negatives decay faster, with no fixed deltas. Inspired by [MH-FLOCKE](https://github.com/MarcHesse/mhflocke)'s R-STDP architecture for quadruped locomotion, where the same mechanism produces stable learning with 11.6x lower variance than PPO.

**Prior art in agent memory simulation.** The idea that human-like memory produces human-like behavior as an emergent property was explored in IEEE research from 2010-2011 ([5952114](https://ieeexplore.ieee.org/document/5952114), [5548405](https://ieeexplore.ieee.org/document/5548405), [5953964](https://ieeexplore.ieee.org/document/5953964)). Walking between rooms and forgetting why you went there doesn't need direct simulation; it emerges naturally from a memory system with capacity limits and decay. Hippo's design follows the same principle: implement the mechanisms, and the behavior follows.

**Related work:** [HippoRAG](https://arxiv.org/abs/2405.14831) (Gutierrez et al., 2024) applies hippocampal indexing to RAG via knowledge graphs. [MemPalace](https://github.com/milla-jovovich/mempalace) (Sigman & Jovovich, 2026) organizes memory spatially (wings/halls/rooms) with AAAK compression, achieving 100% on [LongMemEval](https://arxiv.org/abs/2410.10813). [MH-FLOCKE](https://github.com/MarcHesse/mhflocke) (Hesse, 2026) uses spiking neurons with R-STDP for embodied cognition. Each system tackles a different facet: HippoRAG optimizes retrieval quality, MemPalace optimizes retrieval organization, MH-FLOCKE optimizes embodied learning, and Hippo optimizes memory lifecycle.

---

## Comparison

| Feature | Hippo | MemPalace | Mem0 | Basic Memory |
|---------|-------|-----------|------|-------------|
| Decay by default | Yes | No | No | No |
| Retrieval strengthening | Yes | No | No | No |
| Reward-proportional decay | Yes | No | No | No |
| Hybrid search (BM25 + embeddings) | Yes | Embeddings + spatial | Embeddings only | No |
| Schema acceleration | Yes | No | No | No |
| Conflict detection + resolution | Yes | No | No | No |
| Multi-agent shared memory | Yes | No | No | No |
| Transfer scoring | Yes | No | No | No |
| Outcome tracking | Yes | No | No | No |
| Confidence tiers | Yes | No | No | No |
| Spatial organization | No | Yes (wings/halls/rooms) | No | No |
| Lossless compression | No | Yes (AAAK, 30x) | No | No |
| Cross-tool import | Yes | No | No | No |
| Auto-hook install | Yes | No | No | No |
| MCP server | Yes | Yes | No | No |
| Zero dependencies | Yes | No (ChromaDB) | No | No |
| LongMemEval R@5 (retrieval) | 73.8% (hybrid, v0.28) | 96.6% (raw) / 100% (reranked) | ~49-85% | N/A |
| Git-friendly | Yes | No | No | Yes |
| Framework agnostic | Yes | Yes | Partial | Yes |

Different tools answer different questions. Mem0 and Basic Memory implement "save everything, search later." MemPalace implements "store everything, organize spatially for retrieval." Hippo implements "forget by default, earn persistence through use." These are complementary approaches: MemPalace's retrieval precision + Hippo's lifecycle management would be stronger than either alone.

---

## Benchmarks

Two benchmarks testing two different things. Full details in [`benchmarks/`](benchmarks/).

### LongMemEval (retrieval accuracy)

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) is the industry-standard benchmark: 500 questions across 5 memory abilities, embedded in 115k+ token chat histories.

**Hippo v0.28.0 results (hybrid BM25 + cosine, full 500 questions):**

| Metric | v0.28 | v0.11 (BM25 only) |
|--------|-------|-------------------|
| Recall@1 | 46.6% | 50.4% |
| Recall@3 | **67.0%** | 66.6% |
| Recall@5 | 73.8% | 74.0% |
| Recall@10 | 81.0% | 82.6% |
| Answer in content@5 | **49.6%** | 46.6% |

| Question Type | Count | R@5 | R@10 |
|---------------|-------|-----|------|
| single-session-assistant | 56 | 100.0% | 100.0% |
| knowledge-update | 78 | 89.7% | 96.2% |
| multi-session | 133 | 72.2% | 82.0% |
| temporal-reasoning | 133 | 72.9% | 78.9% |
| single-session-user | 70 | 62.9% | 71.4% |
| single-session-preference | 30 | 20.0% | 33.3% |

For context: MemPalace scores 96.6% (raw) using ChromaDB embeddings + spatial indexing. Hippo v0.28 achieves 73.8% R@5 with hybrid BM25 + cosine. Hybrid scoring trades a little R@1 accuracy for better top-5 content relevance (answer_in_content@5 +3pp vs v0.11).

Hippo's strongest categories (single-session-assistant 100% R@5, knowledge-update 89.7%) are where keyword overlap between question and stored content is highest. The weakest (preference 20%) involves indirect references that need deeper semantic understanding.

> Note: v0.28 R@10 is 1.6pp below v0.11's BM25-only result. The earlier v0.27 benchmark showed an apparent 35pp regression — that was a methodology bug (budget-limited retrieval vs unlimited), fixed in v0.28 with the `minResults` option. See [`evals/README.md`](evals/README.md) for the full investigation and per-type breakdown.

```bash
cd benchmarks/longmemeval
python ingest_direct.py --data data/longmemeval_oracle.json --store-dir ./store
python retrieve_fast.py --data data/longmemeval_oracle.json --store-dir ./store --output results/retrieval.jsonl
python evaluate_retrieval.py --retrieval results/retrieval.jsonl --data data/longmemeval_oracle.json
```

### Sequential Learning Benchmark (agent improvement over time)

No other public benchmark tests whether memory systems produce learning curves. LongMemEval tests retrieval on a fixed corpus. This benchmark tests whether an agent with memory *performs better on task 40 than task 5*.

50 tasks, 10 trap categories, each appearing 2-3 times across the sequence.

**Hippo v0.11.0 results:**

| Condition | Overall | Early | Mid | Late | Learns? |
|-----------|---------|-------|-----|------|---------|
| No memory | 100% | 100% | 100% | 100% | No |
| Static memory | 20% | 33% | 11% | 14% | No |
| Hippo | 40% | 78% | 22% | 14% | Yes |

The hippo agent's trap-hit rate drops from 78% to 14% as it accumulates error memories with 2x half-life. Static pre-loaded memory helps from the start but doesn't improve. Any memory system can run this benchmark by implementing the [adapter interface](benchmarks/sequential-learning/adapters/interface.mjs).

```bash
cd benchmarks/sequential-learning
node run.mjs --adapter all
```

---

## Contributing

Issues and PRs welcome. Before contributing, run `hippo status` in the repo root to see the project's own memory.

The interesting problems:
- **Improve LongMemEval score.** Current R@5 is 73.8% with hybrid BM25 + cosine (v0.28). Gap to MemPalace's 96.6% likely needs better chunking, reranking, or semantic compression — not just more of the same retrieval.
- Better consolidation heuristics (LLM-powered merge vs current text overlap)
- Web UI / dashboard for visualizing decay curves and memory health
- Optimal decay parameter tuning from real usage data
- Cross-agent transfer learning evaluation
- **MemPalace-style spatial organization.** Could spatial structure (wings/halls/rooms) improve hippo's semantic layer?
- **AAAK-style compression for semantic memories.** Lossless token compression for context injection.

## License

MIT
