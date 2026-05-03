# Continuity-First Recall Implementation Plan

**Goal:** Make `api.recall` optionally return a continuity block (`activeSnapshot`, `sessionHandoff`, `recentSessionEvents`) and surface it through CLI `hippo recall --continuity`. One recall call gives an agent both relevant memories AND where it left off.

**Architecture:** Additive flag (`includeContinuity`, default false) on `RecallOpts` to preserve hot path. When true, `api.recall` calls the v1.0.0 tenant-scoped store helpers (`loadActiveTaskSnapshot`, `loadLatestHandoff`, `listSessionEvents`, all keyed on `ctx.tenantId`) and returns them in an optional `continuity` field on `RecallResult`, plus a `continuityTokens` count for budget visibility. CLI assembles the same continuity block AFTER its existing hybrid/physics pipeline rather than swapping in api.recall.

**Scope (narrowed by codex round 1):** This slice ships api.recall + CLI only. MCP `hippo_recall` and HTTP `GET /v1/memories` exposure is deferred to a follow-up plan that lands TOGETHER with the `scope` read-side filter, because exposing continuity beyond CLI widens the unfiltered surface beyond what v1.0.0's `scope`-NULL state guarantees.

**Tech Stack:** TypeScript, node:sqlite, vitest. No schema change (v22 already shipped in v1.0.0).

**Roadmap source:** `docs/plans/2026-04-28-company-brain-measurement.md` "First real product slice next: continuity-first context assembly"; ROADMAP.md `[Committed]`. Supersedes the parked `docs/plans/2026-05-02-continuity-first-recall.md` whose blockers cleared in v1.0.0.

**Hot-path discipline:** Continuity reads only fire when caller opts in. Path is: 1 SELECT for the active snapshot (with a conditional mirror-file write inside `loadActiveTaskSnapshot`) + 1 SELECT for the handoff + 1 SELECT for the last 5 events + the existing `audit_log` insert in `api.recall`. Not a pure read path. Bench methodology in Task 6 measures delta only against the same route + same cache mode + same store, not against the existing absolute p99 gate.

**Effort budget:** 1 session, ~5 tasks, 3-5 commits. Target release: v1.1.0.

---

## Pre-flight

Read these before Task 1:

- `src/api.ts:90-187` — current `RecallOpts` / `RecallResult` / `recall()` shape, default-deny scope rule, tenant-aware reads
- `src/cli.ts` — search for `cmdRecall` and the existing `hippo context` continuity assembly (the pattern to mirror)
- `src/store.ts` — `loadActiveTaskSnapshot(hippoRoot, tenantId)`, `listSessionEvents(hippoRoot, tenantId, opts)`, `loadLatestHandoff(hippoRoot, tenantId, sessionId?)`. All require `tenantId` post-v1.0.0; `assertTenantId` will throw on misbinding.
- `src/mcp/server.ts` — search for `hippo_recall` tool body
- `tests/company-brain-scorecard.test.ts` — measurement scorecard (we'll extend it)
- `tests/continuity-tables-tenant-isolation.test.ts` — tenant-isolation regression suite (Task 5 should not break these)

**API shape post-v1.0.0:** every continuity helper takes `(hippoRoot, tenantId, ...rest)`. Inside `recall()` we already have `ctx.tenantId`. There is no `undefined = all tenants` escape — that was the v0.40 → v1.0 leak vector and is now a runtime-guarded error.

---

## Task 1: Extend RecallOpts and RecallResult

**Files:**
- Modify: `src/api.ts:94-187`
- Test: `tests/api-recall-continuity.test.ts` (new)

**Step 1: Write the failing test**

```typescript
// tests/api-recall-continuity.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
  writeEntry,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { recall } from '../src/api.js';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-recall-cont-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('api.recall continuity flag', () => {
  it('defaults to no continuity block (hot path)', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('test memory about widgets', {}));

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'widgets' },
    );
    expect(result.continuity).toBeUndefined();
  });

  it('includes snapshot, handoff, and recent events when includeContinuity=true', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('memory about deploys', {}));
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Ship the recall continuity slice',
      summary: 'Plan reviewed, implementation in progress.',
      next_step: 'Run tests, then commit.',
      session_id: 'sess-1',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-1',
      summary: 'Mid-implementation handoff.',
      nextAction: 'Pick up at Task 3.',
      artifacts: ['src/api.ts'],
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess-1',
      event_type: 'note',
      content: 'A trail event we want to surface.',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'deploys', includeContinuity: true },
    );
    expect(result.continuity).toBeDefined();
    expect(result.continuity!.activeSnapshot?.task).toBe('Ship the recall continuity slice');
    expect(result.continuity!.sessionHandoff?.nextAction).toBe('Pick up at Task 3.');
    expect(result.continuity!.recentSessionEvents).toHaveLength(1);
  });

  it('returns continuity block with nulls/empty when no continuity state exists', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('lonely memory', {}));

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'lonely', includeContinuity: true },
    );
    expect(result.continuity).toBeDefined();
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
  });

  // CRITICAL — closes the v0.40 leak class on the recall surface itself.
  it('does not surface another tenant continuity', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A secret',
      summary: 'A',
      next_step: 'A',
      session_id: 'sess-a',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'sess-a',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });
    appendSessionEvent(tmpDir, 'tenantA', {
      session_id: 'sess-a',
      event_type: 'note',
      content: 'A trail',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'tenantB', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
  });

  // codex P2: do not resurrect a stale handoff when the active snapshot is gone.
  it('does not surface a handoff from a session with no active snapshot', () => {
    initStore(tmpDir);
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-completed-yesterday',
      summary: 'Yesterday I shipped a thing.',
      nextAction: 'Should not resurface today.',
      artifacts: [],
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
  });

  it('reports continuityTokens when block is present', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'aaaa',
      summary: 'bbbb',
      next_step: 'cccc',
      session_id: 'sess-1',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    // 4 + 4 + 4 chars at Math.ceil(len/4) = 1+1+1 = 3
    expect(result.continuityTokens).toBe(3);
  });
});
```

**Step 2: Run failing**

Run: `npx vitest run tests/api-recall-continuity.test.ts`
Expected: FAIL — `continuity` not on RecallResult; `includeContinuity` not on RecallOpts.

**Step 3: Implement**

In `src/api.ts`, add imports near the top:

```typescript
import {
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  listSessionEvents,
  type TaskSnapshot,
  type SessionEvent,
} from './store.js';
import type { SessionHandoff } from './handoff.js';
```

Extend the interfaces (replace lines 94-122):

```typescript
export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}

export interface RecallOpts {
  query: string;
  limit?: number;
  mode?: 'bm25' | 'hybrid' | 'physics';
  scope?: string;
  /**
   * When true, include continuity context (active task snapshot, latest matching
   * session handoff, recent session events) on the result. Default false to keep
   * the hot path cheap; agent boot paths should set this to true.
   *
   * All three lookups are tenant-scoped to ctx.tenantId via the v0.40+ store
   * helpers — no risk of cross-tenant leak.
   */
  includeContinuity?: boolean;
}

export interface RecallResultItem {
  id: string;
  content: string;
  score: number;
  layer: string;
  strength: number;
}

export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
  /**
   * Tokens consumed by the continuity block: snapshot (task + summary + next_step)
   * + handoff (summary + nextAction + artifacts) + every event's full content
   * across the last 5 events. Each measured by Math.ceil(len/4), matching
   * estimateTokens() in src/search.ts and the existing api.recall tokens count.
   * Undefined when continuity not requested. Callers that need a tighter budget
   * should truncate event.content themselves before display.
   */
  continuityTokens?: number;
}
```

In `recall()`, immediately before `return { results: ranked, total: entries.length, tokens };`:

```typescript
let continuity: ContinuityBlock | undefined;
let continuityTokens: number | undefined;
if (opts.includeContinuity) {
  const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId);
  // No active snapshot = no anchor = no handoff/events. Avoids resurrecting a
  // stale handoff from a deleted/completed session, which the codex review
  // flagged as a P2 stale-state hazard.
  const sessionId = snapshot?.session_id ?? undefined;
  const sessionHandoff = sessionId
    ? loadLatestHandoff(ctx.hippoRoot, ctx.tenantId, sessionId)
    : null;
  const recentSessionEvents = sessionId
    ? listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: 5 })
    : [];
  continuity = {
    activeSnapshot: snapshot,
    sessionHandoff,
    recentSessionEvents,
  };
  // Token budget for the continuity payload. Same Math.ceil(len/4) rule used
  // for `tokens` so a caller can sum the two for total recall payload size.
  const tokenize = (s?: string | null): number =>
    s ? Math.ceil(s.length / 4) : 0;
  continuityTokens =
    tokenize(snapshot?.task) +
    tokenize(snapshot?.summary) +
    tokenize(snapshot?.next_step) +
    tokenize(sessionHandoff?.summary) +
    tokenize(sessionHandoff?.nextAction) +
    (sessionHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenize(a), 0) +
    recentSessionEvents.reduce((acc, e) => acc + tokenize(e.content), 0);
}

return { results: ranked, total: entries.length, tokens, continuity, continuityTokens };
```

Note: when no active snapshot, the continuity block is `{ activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] }`. This is a deliberate departure from the parked plan — codex flagged that an unanchored `loadLatestHandoff(tenantId)` returns the latest tenant row regardless of liveness/repo/age, which would surface stale handoffs after a session ended. Cleaner to require an anchor.

**Step 4: Run passing**

Run: `npx vitest run tests/api-recall-continuity.test.ts`
Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add src/api.ts tests/api-recall-continuity.test.ts
git commit -m "feat(api): optional continuity block on RecallResult"
```

---

## Task 2 (deferred): MCP `hippo_recall` continuity

**Status:** Deferred to a follow-up plan that lands TOGETHER with the `scope` read-side filter on continuity tables.

**Why:** codex round 1 found two reasons not to bundle:

1. `hippo_recall` is a TEXT-returning MCP tool (src/mcp/server.ts:119, :281). Adding a structured `continuity` field is a breaking change to the MCP contract and forces every existing client to handle two return shapes.
2. Exposing continuity through an LLM-facing surface widens the unfiltered private-channel risk: README:116 promises default-deny on `slack:private:*` for memory recall, but continuity tables ship with `scope=NULL` and no read-side filter (v1.0.0 known limitation). Until scope is wired, MCP/HTTP exposure of continuity = real surface-area regression vs the v1.0.0 guarantees.

The follow-up plan should: (a) wire scope writers (Slack connector emits `scope='slack:private:<channel>'` for private channels on snapshots/events/handoffs originating there), (b) add the read-side default-deny filter in api.recall continuity reads, (c) THEN expose via MCP using a text "## Continuity" appendix to keep the existing return shape stable.

**Existing MCP exposure (unchanged in this slice):** `hippo_context` (src/mcp/server.ts:395) ALREADY surfaces the active snapshot over MCP today. This is not new exposure created by the present plan, and the same v1.0.0 "Known limitation: scope=NULL on continuity tables" applies. The v1.2.0 follow-up MUST include `hippo_context` in the scope-filter audit alongside any new `hippo_recall` continuity work — do not let it slip through because the surface predates this slice.

---

## Task 3 (deferred): HTTP `GET /v1/memories` continuity

**Status:** Deferred alongside Task 2 for the same scope-leak reasoning.

**Note for the follow-up plan:** the actual route is `GET /v1/memories` at src/server.ts:404 (calls `recall()` at :420). NOT `POST /v1/recall` as the parked plan and round-1 plan body assumed. Extension path: `GET /v1/memories?include_continuity=true` returns the continuity block as a JSON sibling field, with the same scope filter applied that protects memory recall.

**No `/v1/context` or `/v1/learn` routes exist** (codex round 2 verified). MCP `hippo_context` is the only currently-shipping surface that exposes a continuity primitive (the active snapshot). See Task 2 deferral note.

---

## Task 4: CLI `hippo recall --continuity`

**Files:**
- Modify: `src/cli.ts` (`cmdRecall` function)
- Test: `tests/cli-recall-continuity.test.ts` (new)

**Step 1: Failing test**

CLI integration tests (mirror `tests/correction-latency-cli.test.ts`):

1. Seed continuity state under `default` + a memory matching `query`. Run `hippo recall <query> --continuity --json`. Assert JSON has `continuity.activeSnapshot.task`, `continuity.sessionHandoff`, `continuity.recentSessionEvents`, plus `memories` populated.
2. Text mode: same setup, no `--json`. Assert the headings emitted by the reused formatters appear above the memory list: `## Active Task Snapshot`, `## Session Handoff`, `## Recent Session Trail` (these come from `printActiveTaskSnapshot` at src/cli.ts:2727, `printHandoff` at :3055, `printSessionEvents` at :2745). Do NOT assert a generic `## Continuity` heading — that wrapper does not exist and adding it would diverge from `hippo context` parity.
3. **Zero-result regression (codex round 2 P1):** seed continuity state but use a query that matches NO memories. Run `hippo recall <no-match> --continuity`. Assert continuity is still printed (and not the "No memories found" early return). Add the same case in `--json` mode and assert continuity is in the JSON even when `memories: []`.

**Step 2: Implement**

`cmdRecall` (src/cli.ts:757) runs its own hybrid/physics/global/multihop/goal/audit/retrieval pipeline and does NOT route through `api.recall`. Routing the continuity-on path through `api.recall` would silently drop existing CLI behavior (codex round 1 P1).

Approach: assemble continuity AFTER the existing `cmdRecall` pipeline using the same three store helpers `api.recall` uses. Reuse the formatter pattern already in `cmdContext` (`printActiveTaskSnapshot`, `printHandoff`, `printSessionEvents` at src/cli.ts:3472-3474) so the on-screen output matches `hippo context` for free.

Concretely in `cmdRecall`:
- Add `--continuity` flag parser.
- **Assemble continuity EARLY**, after the search results are computed but BEFORE the zero-result early-return at src/cli.ts:1218. Otherwise `hippo recall <no-match> --continuity` drops the resume packet (codex round 2 P1).
- When `flags['continuity']`:
  - `const tenantId = resolveTenantId({});`
  - `const activeSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);`
  - `const sessionId = activeSnapshot?.session_id ?? undefined;`
  - `const sessionHandoff = sessionId ? loadLatestHandoff(hippoRoot, tenantId, sessionId) : null;`
  - `const recentSessionEvents = sessionId ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: 5 }) : [];`
  - Compute `continuityTokens` with the same `Math.ceil(len/4)` rule used in api.recall (DRY: extract a shared helper. The codebase already has `estimateTokens` at src/search.ts:106 — reuse that.).
- Restructure the zero-result branch: when memories are empty AND `--continuity` produced any non-null/non-empty continuity primitive, fall through to the print/serialize path with `memories: []` instead of returning "No memories found". When memories AND continuity are both empty, keep the existing message.
- When `--json`, add `continuity` and `continuityTokens` keys to the output object.
- When text, call `printActiveTaskSnapshot(activeSnapshot); printHandoff(sessionHandoff); printSessionEvents(recentSessionEvents);` BEFORE the memory list. These emit `## Active Task Snapshot`, `## Session Handoff`, `## Recent Session Trail` headings respectively.

Hot-path: when `--continuity` is NOT set, `cmdRecall` is unchanged. No new code path runs.

Update the help block to document `--continuity`.

**Related explicit path (do not collapse):** `hippo session resume` at src/cli.ts:3022 intentionally surfaces the latest handoff WITHOUT requiring an active snapshot. That is the explicit "I lost my snapshot, give me the last handoff anyway" path. Auto-continuity in `hippo recall` stays anchored to active snapshot to avoid surprise resurrection of stale handoffs after a session ends.

**Step 3: Commit**

```bash
git add src/cli.ts tests/cli-recall-continuity.test.ts
git commit -m "feat(cli): hippo recall --continuity surfaces snapshot + handoff + trail"
```

---

## Task 5: Scorecard regression — continuity-on path passes existing gates

**Files:**
- Modify: `tests/company-brain-scorecard.test.ts`

Add a new test inside the scorecard suite that exercises the recall path (not just the in-test `buildResumeScorecard` helper). Asserts:

- `recall(..., { includeContinuity: true })` populates the same signals the scorecard counts.
- Coverage signal increases vs the no-continuity baseline.
- Distilled token count from the recall path (snapshot.task + summary + next_step + handoff.summary + nextAction + artifacts + full content of last 5 events) stays below 45% of the raw event transcript token count.

This wires the new feature into the existing measurement gate rather than measuring it ad-hoc.

**Commit:**

```bash
git add tests/company-brain-scorecard.test.ts
git commit -m "test(scorecard): assert recall+continuity hits the same gates"
```

---

## Task 6: Hot-path benchmark — delta only

**Files:**
- Read: `benchmarks/a1/p99-recall.ts`
- Add: `benchmarks/a1/p99-recall-continuity.ts`

**Methodology (codex round 1 P1):** the existing `p99-recall.ts` measures cold-cache `GET /v1/memories` against a documented 50ms gate that already failed at ~58ms. That benchmark's absolute number is not the target here. This task measures the delta only.

Concretely:
- Same store fixture (10k memories), seeded once.
- Same call path: in-process `api.recall(..., { includeContinuity: false })` vs `api.recall(..., { includeContinuity: true })`. Skip the HTTP layer — it's deferred (Task 3).
- Same cache mode (warm DB after a discarded warmup pass).
- Same iteration count (use whatever `p99-recall.ts` uses).
- Seed exactly one active snapshot + one handoff + 5 events for the continuity-on run, so the helper paths actually do work.

**Pass criteria:** `p99(continuity=true) - p99(continuity=false) < 5ms`. If the delta exceeds 5ms, run `EXPLAIN QUERY PLAN` against `listSessionEvents` to confirm `idx_session_events_tenant_session` is hit and not a full scan.

Output: a results JSON under `benchmarks/a1/results/p99-recall-continuity.json` with both p99 values, the delta, and the iteration count. Do NOT compare against the existing 50ms absolute gate.

**Commit:**

```bash
git add benchmarks/a1/...
git commit -m "bench: continuity-on recall p99 within budget"
```

---

## Definition of Done

1. `npm run build` clean.
2. Full vitest suite passes (1039+ tests, no regressions on `tests/continuity-tables-tenant-isolation.test.ts`).
3. New tests added for: api unit (incl. tenant-isolation + stale-handoff anti-resurrection + continuityTokens), CLI integration, scorecard regression.
4. `hippo recall <query> --continuity` produces a useful resume packet against the live `~/.hippo` store.
5. p99 bench DELTA < 5ms (api.recall in-process). Absolute p99 not asserted.
6. CHANGELOG.md updated under `## 1.1.0 (date)` — Added section. Note in the entry that MCP/HTTP exposure is deferred to v1.2.0 alongside scope read-side filtering.
7. README.md "What's new in v1.1.0" section added.
8. Codex review completed (see GSTACK REVIEW REPORT below). Round 1 status: 5 P1s + 4 P2s, all addressed or explicitly deferred.

## Out of scope (next slice)

- **`scope` read-side filter on continuity tables.** v22 added the column, v1.0.0 ships with NULL writes only. Wiring scope means: writers need to set it (Slack connector → 'private' for private channels), then `recall()` continuity reads need to apply the same default-deny rule already on memory recall. Worth its own plan; do not bundle here.
- Scoring continuity recency (e.g., suppress events older than N days).
- Replacing `hippo context` with a thin wrapper over `recall + continuity` — possible cleanup once parity is shown, but a separate PR.
- Surfacing continuity from `physicsSearch` / `hybridSearch` directly (currently the MCP handler re-runs those on top of api.recall; continuity flows via api.recall).

---

## GSTACK REVIEW REPORT

Codex review 2026-05-03 round 1 (pre-implementation):

| # | Severity | Status | Note |
|---|---|---|---|
| 1 | P1 | FIXED | CLI plan rewritten (Task 4): assemble continuity AFTER the existing cmdRecall pipeline using the same store helpers, reuse `printActiveTaskSnapshot`/`printHandoff`/`printSessionEvents` formatters from cmdContext. No swap to api.recall. |
| 2 | P1 | DEFERRED | HTTP exposure deferred to v1.2.0 follow-up plan that lands together with scope read-side filtering. Note in plan body documents the actual route (`GET /v1/memories`, src/server.ts:404), not the `POST /v1/recall` the round-1 draft assumed. |
| 3 | P1 | DEFERRED | MCP exposure deferred for the same reason as #2. Follow-up plan to use a text "## Continuity" appendix in the existing return string, not a structured field. |
| 4 | P1 | RESOLVED (option a) | Slice narrowed to CLI + api.recall only. MCP/HTTP exposure deferred until scope read-side filter lands. Decision logged in plan Architecture + Out-of-scope. |
| 5 | P1 | FIXED | Task 6 rewritten: delta-only methodology against in-process api.recall, same fixture/cache/iterations, no reuse of old absolute 50ms gate. |
| 6 | P2 | FIXED | Dropped the no-sessionId fallback for `loadLatestHandoff`. If no active snapshot, sessionHandoff is null. New regression test asserts a stale handoff does NOT resurface when no anchor exists. |
| 7 | P2 | FIXED | Added `continuityTokens` to RecallResult contract with the same `Math.ceil(len/4)` rule as `tokens`. New test asserts the count. |
| 8 | P2 | FIXED | Architecture wording updated: opt-in read path with audit log entry + 1 conditional mirror write inside `loadActiveTaskSnapshot`. Not "three pure DB reads." |
| 9 | P2 | FIXED | Removed the "REQUIRED SUB-SKILL: superpowers:executing-plans" directive at line 3. |

Codex review 2026-05-03 round 2 (post-revision):

| # | Severity | Status | Note |
|---|---|---|---|
| 10 | P1 | FIXED | Deferred-MCP boundary was incomplete: `hippo_context` (src/mcp/server.ts:395) already exposes the active snapshot over MCP. Plan now explicitly states this surface predates the slice, is covered by the v1.0.0 known limitation, and MUST be included in the v1.2.0 scope-filter follow-up alongside any new `hippo_recall` work. No `/v1/context` or `/v1/learn` HTTP routes exist (verified). |
| 11 | P1 | FIXED | CLI zero-result branch would have dropped continuity. Task 4 now requires assembling continuity BEFORE the existing `cmdRecall` early-return at src/cli.ts:1218, restructuring the zero-result path to print/serialize continuity when memories are empty but continuity is non-empty. Added regression test (text + JSON modes). |
| 12 | P2 | FIXED | Task 4 text test was asserting a `## Continuity` wrapper that doesn't exist. Updated to assert the actual headings emitted by the reused formatters: `## Active Task Snapshot`, `## Session Handoff`, `## Recent Session Trail`. |
| 13 | P2 | FIXED | `continuityTokens` doc said "event content previews" but math counts full event.content. Doc rewritten to match the math; truncation responsibility lives with callers. Same fix in Task 5 scorecard description. |
| 14 | P2 | FIXED | Documented the explicit handoff-without-snapshot path: `hippo session resume` (src/cli.ts:3022) is the intentional escape hatch. Auto-continuity in `hippo recall` stays anchored to active snapshot. |
