# Continuity-First Recall Implementation Plan

> **STATUS: SUPERSEDED (2026-05-03).** Schema v22 shipped in v1.0.0 and unblocked
> the tenant leak. The current plan is `docs/plans/2026-05-03-continuity-first-recall.md`,
> which uses the v1.0.0 tenant-required helper signatures. This file is kept as
> historical record (codex review trail).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `api.recall` optionally return a continuity block (`activeSnapshot`, `sessionHandoff`, `recentSessionEvents`) and propagate the flag through MCP `hippo_recall`, HTTP `/v1/recall`, and CLI `hippo recall`. One recall call gives an agent both relevant memories AND where it left off.

**Architecture:** Additive flag (`includeContinuity`, default false) on `RecallOpts` to preserve hot path. When true, `api.recall` loads the three primitives via existing store helpers and returns them in an optional `continuity` field on `RecallResult`. Surfaces propagate the flag verbatim.

**Tech Stack:** TypeScript, node:sqlite, vitest. No schema change.

**Roadmap source:** `docs/plans/2026-04-28-company-brain-measurement.md` "First real product slice next: continuity-first context assembly"; ROADMAP.md `[Committed]`.

**Hot-path discipline:** Continuity reads only fire when caller opts in. Three additional DB reads (snapshot + handoff + last 5 events). Bench impact target: < 5ms added p99 on a warm DB; verify against existing `benchmarks/a1/p99-recall.ts`.

**Effort budget:** 1 session, ~6 tasks, 4-6 commits.

---

## Pre-flight

Read these before Task 1:

- `src/api.ts:90-187` — current `RecallOpts` / `RecallResult` / `recall()` shape, default-deny scope rule
- `src/cli.ts:3299-3505` — existing `hippo context` continuity assembly (the pattern to mirror)
- `src/store.ts:1373` (`loadActiveTaskSnapshot`), `src/store.ts:1476` (`listSessionEvents`), `src/store.ts:1780` (`loadLatestHandoff`)
- `src/mcp/server.ts:281` — current `hippo_recall` tool body
- `tests/company-brain-scorecard.test.ts` — measurement scorecard (we'll extend it)

---

## Task 1: Extend RecallOpts and RecallResult

**Files:**
- Modify: `src/api.ts:94-122` (interfaces)
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
    saveActiveTaskSnapshot(tmpDir, {
      task: 'Ship the recall continuity slice',
      summary: 'Plan reviewed, implementation in progress.',
      next_step: 'Run tests, then commit.',
      session_id: 'sess-1',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-1',
      summary: 'Mid-implementation handoff.',
      nextAction: 'Pick up at Task 3.',
      artifacts: ['src/api.ts'],
    });
    appendSessionEvent(tmpDir, {
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
});
```

**Step 2: Run failing**

Run: `npx vitest run tests/api-recall-continuity.test.ts`
Expected: FAIL — `continuity` not on RecallResult; `includeContinuity` not on RecallOpts.

**Step 3: Implement**

In `src/api.ts`, near the existing interfaces:

```typescript
import {
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  listSessionEvents,
  type TaskSnapshot,
  type SessionEvent,
} from './store.js';
import type { SessionHandoff } from './handoff.js';

export interface ContinuityBlock {
  activeSnapshot: TaskSnapshot | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEvent[];
}

// extend RecallOpts:
export interface RecallOpts {
  query: string;
  limit?: number;
  mode?: 'bm25' | 'hybrid' | 'physics';
  scope?: string;
  /**
   * When true, include continuity context (active task snapshot, latest matching
   * session handoff, recent session events) on the result. Default false to keep
   * the hot path cheap; agent boot paths should set this to true.
   */
  includeContinuity?: boolean;
}

// extend RecallResult:
export interface RecallResult {
  results: RecallResultItem[];
  total: number;
  tokens: number;
  continuity?: ContinuityBlock;
}
```

In `recall()`, after the existing `audit_log` write and before `return`:

```typescript
let continuity: ContinuityBlock | undefined;
if (opts.includeContinuity) {
  const snapshot = loadActiveTaskSnapshot(ctx.hippoRoot);
  const sessionId = snapshot?.session_id ?? undefined;
  const sessionHandoff = sessionId ? loadLatestHandoff(ctx.hippoRoot, sessionId) : null;
  const recentSessionEvents = sessionId
    ? listSessionEvents(ctx.hippoRoot, { session_id: sessionId, limit: 5 })
    : [];
  continuity = {
    activeSnapshot: snapshot,
    sessionHandoff,
    recentSessionEvents,
  };
}

return { results: ranked, total: entries.length, tokens, continuity };
```

**Step 4: Run passing**

Run: `npx vitest run tests/api-recall-continuity.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/api.ts tests/api-recall-continuity.test.ts
git commit -m "feat(api): optional continuity block on RecallResult"
```

---

## Task 2: MCP `hippo_recall` accepts include_continuity

**Files:**
- Modify: `src/mcp/server.ts:119-145` (tool schema), `:281-340` (handler)
- Test: `tests/mcp-recall-continuity.test.ts` (new)

**Step 1: Failing test**

Test invokes the MCP tool handler directly (not over JSON-RPC). Stand up a temp store, seed snapshot + handoff + memory, call `hippo_recall` with `include_continuity: true`, assert response carries `continuity.activeSnapshot.task`.

**Step 2: Implement**

- Add `include_continuity: { type: 'boolean' }` to the `hippo_recall` input schema.
- In the handler at `src/mcp/server.ts:281`, pass `includeContinuity: Boolean(args.include_continuity)` into `apiRecall`.
- After the physics/hybrid scorer runs, if `includeContinuity`, take the continuity block from the api.recall return and include it in the MCP response shape.

**Step 3: Commit**

```bash
git add src/mcp/server.ts tests/mcp-recall-continuity.test.ts
git commit -m "feat(mcp): hippo_recall surfaces continuity when include_continuity=true"
```

---

## Task 3: HTTP /v1/recall accepts ?continuity=1

**Files:**
- Modify: `src/server.ts` (recall route handler)
- Test: `tests/http-recall-continuity.test.ts` (new)

**Step 1: Failing test**

End-to-end: stand up a real server via `serve()`, POST to `/v1/recall` with `{query: '...', include_continuity: true}` (or `?continuity=1` query param), assert JSON response carries `continuity` object.

**Step 2: Implement**

Find the recall route in `src/server.ts`, parse `include_continuity` from JSON body OR `?continuity=1` query param, pass through to `api.recall`. Default false.

**Step 3: Commit**

```bash
git add src/server.ts tests/http-recall-continuity.test.ts
git commit -m "feat(http): /v1/recall propagates include_continuity"
```

---

## Task 4: CLI `hippo recall --continuity`

**Files:**
- Modify: `src/cli.ts` (`cmdRecall` function)

**Step 1: Test**

CLI integration test (mirror `tests/correction-latency-cli.test.ts`): seed continuity state, run `hippo recall <query> --continuity --json`, parse JSON, assert continuity block.

**Step 2: Implement**

In `cmdRecall`, when `flags['continuity']` is true, pass through to `api.recall` (or to the underlying call if cmdRecall doesn't currently route through api.recall — verify first; some paths use search.ts directly). When `--json`, include continuity in the JSON output. When text, print a "## Continuity" section above the memories list (mirror `hippo context` formatting).

Also: update the help block in `cli.ts:5253` to document `--continuity`.

**Step 3: Commit**

```bash
git add src/cli.ts tests/cli-recall-continuity.test.ts
git commit -m "feat(cli): hippo recall --continuity surfaces snapshot + handoff + trail"
```

---

## Task 5: Scorecard regression — continuity-on path passes existing gates

**Files:**
- Modify: `tests/company-brain-scorecard.test.ts`

Add a new test inside `describe('Company Brain continuity scorecard scaffold', ...)` that exercises the recall path (not just the in-test `buildResumeScorecard` helper). Asserts:

- `recall(..., { includeContinuity: true })` populates the same signals the scorecard counts.
- Coverage signal increases vs the no-continuity baseline.
- Distilled token count from the recall path (snapshot.task + summary + handoff.summary + nextAction + last event preview) stays below 45% of the raw event transcript token count.

This wires the new feature into the existing measurement gate rather than measuring it ad-hoc.

**Commit:**

```bash
git add tests/company-brain-scorecard.test.ts
git commit -m "test(scorecard): assert recall+continuity hits the same gates"
```

---

## Task 6: Hot-path benchmark sanity

**Files:**
- Read: `benchmarks/a1/p99-recall.ts`
- Add: `benchmarks/a1/p99-recall-continuity.ts` (or a flag on the existing one)

Run the existing 10k-memory p99 bench unchanged (no continuity) and capture baseline. Run again with `includeContinuity: true` against a store seeded with one snapshot + handoff + 5 events. Compare. Ship target: continuity-on adds < 5ms to p99. If it adds more, investigate the listSessionEvents path or cache the snapshot lookup per call.

Output: a results JSON committed under `benchmarks/a1/results/p99-recall-continuity.json`.

**Commit:**

```bash
git add benchmarks/a1/...
git commit -m "bench: continuity-on recall p99 within budget"
```

---

## Definition of Done

1. `npm run build` clean.
2. Full vitest suite passes (1020+ tests, no regressions).
3. New tests added for: api unit, MCP integration, HTTP integration, CLI integration, scorecard regression.
4. `hippo recall <query> --continuity` produces a useful resume packet against the live `~/.hippo` store.
5. p99 bench delta < 5ms.
6. CHANGELOG.md updated under `## 0.41.0 (date)` (will batch with the v0.40.1 Slack fix).
7. README.md "What's new in v0.41.0" section added.

## Out of scope (next slice)

- Scoring continuity recency (e.g., suppress events older than N days).
- Replacing `hippo context` with a thin wrapper over `recall + continuity` — possible cleanup once parity is shown, but a separate PR.
- Surfacing continuity from `physicsSearch` / `hybridSearch` directly (currently the MCP handler re-runs those on top of api.recall; continuity flows via api.recall).

## GSTACK REVIEW REPORT

(To be filled by `/codex review` or `/plan-eng-review` before any task implementation.)
