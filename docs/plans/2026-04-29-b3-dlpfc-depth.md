# B3 dlPFC Persistent Goal Stack Depth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

> **Revision log:**
> - **v2 (post-codex round 1):** mechanism rewrite (drop trap-rate −10pp claim; success becomes a controlled paired test on a new B3 micro-fixture), schema hardening (FKs, CHECKs, tenant+session on `goal_recall_log`, composite index), correctness fixes (insert order, push transaction, multiplier hard cap, lifespan-windowed outcome propagation), API surface (recall integration moves from `src/api.ts` to `src/cli.ts`; tests use `ctx`-form `remember(ctx, opts)` / `recall(ctx, opts)`).
> - **v3 (post-codex round 2):** test env var fix `HIPPO_HOME` (not `HIPPO_ROOT`, src/shared.ts:27); CLI flag fix `--filter dlpfc-depth` (not `--fixture`); success metric simplified to "all 3 fixture queries pass under existing `run.py` semantics" (drop Wilcoxon `paired_ab.py` which doesn't exist; statistical version moves to v0.39 stretch); fixture keys corrected to `must_contain_any` / `must_not_contain_any` (drop `_top_3` suffix); accept `goal_stack.retrieval_policy_id` as denormalized non-FK pointer (reverse FK on retrieval_policy.goal_id already cascades).
> - **v3.2 (real-master discovery):** Original plan assumed schema baseline at v13, but actual master tip is at v17 (v14 A3 envelope, v15 A3 hardening, v16 A5 tenant+auth, v17 E1.3 slack). Working tree had been corrupted by an earlier `git checkout feat/dlpfc-goals -- :/` reverting all source files. Restored via `git reset --hard HEAD`. B3 schema migration is now **v18**, not v14. All test pins go from 17→18 (not 13→14). Header, success criteria, Task 0 baseline check, Task 1 schema implementation, and CHANGELOG section all updated.
> - **v3.3:** Task 7 fixture text fix — original wording was lexically too divergent from query so cap+ranking were mutually exclusive; expanded lesson text to share 'auth refactor' tokens.

**Goal:** Promote the `--goal <tag>` MVP into a persistent, session-and-tenant-scoped goal stack with retrieval policies and lifespan-windowed outcome propagation, with a paired-A/B benchmark proving goal-conditioned lift at p<0.05.

**Architecture:** Three new tables (`goal_stack`, `retrieval_policy`, `goal_recall_log`) added in schema migration v18, gated by `(tenant_id, session_id)` and capped at 3 active goals. The boost happens **post-hoc inside `src/cli.ts`** (the same place the existing `--goal <tag>` MVP lives at line 967), not inside `src/api.ts:recall()`. The CLI reads `HIPPO_SESSION_ID` + `HIPPO_TENANT` from env, calls `getActiveGoals(db, ...)`, applies a policy-weighted multiplier with a hard cap of 3.0x on the final score, and writes `goal_recall_log` rows attributing each top-K result to the goal that boosted it. Goal completion with `--outcome <n>` walks `goal_recall_log` rows whose `recalled_at` falls inside the goal's `[created_at, completed_at]` lifespan window and adjusts memory `strength` by ±10% / ±15% (clamped to [0,1]). The MVP `--goal <tag>` flag stays as a manual override.

Keeping the integration in `src/cli.ts` means **`src/api.ts:recall()` and the `RecallOpts` type are unchanged**. The MCP/REST surfaces (`src/server.ts:399`, `/recall` endpoint) do not need to thread `session_id` in v0.38; that is a v0.39 follow-up.

**Tech Stack:** TypeScript, node:sqlite, vitest (real DB only), Python-3 paired-A/B harness in `benchmarks/micro/`.

**Branch:** `feat/b3-dlpfc-depth`

**Success criteria (verifiable):**
1. Schema migration v18 applies cleanly on a fresh DB and idempotently on an existing v17 hippo database (verified by re-opening after migration).
2. `hippo goal push/list/complete/suspend/resume` round-trip through SQLite, capped at depth 3 active per `(tenant_id, session_id)` pair, with auto-suspend-oldest enforced under concurrent-push transaction.
3. `hippo recall` auto-applies a goal-stack boost when env carries `HIPPO_SESSION_ID` and the session has active goals; the existing `dlpfc-goals` micro-fixture continues to pass under the new path.
4. **Primary metric:** a new `benchmarks/micro/fixtures/dlpfc_depth.json` with three disjoint memory clusters and three named goals each owning a cluster. Verified via the existing `benchmarks/micro/run.py` harness extended once in Task 11 to support per-query `pre_actions` (the existing harness has fixture-level `actions` only). The fixture contains 3 queries, each sharing the ambiguous text "rewrite step", each paired with a different `goal_push` pre-action. Each query asserts the active goal's cluster word IS in top-3 (`must_contain_any`) AND the other two clusters' words are NOT in top-3 (`must_not_contain_any`). The asymmetric `must_not_contain_any` is what makes the test load-bearing: BM25 alone cannot satisfy it because all 18 memories share the query terms; only the goal-tag boost can. All 3 queries must pass.
5. `goal complete --outcome <n>` adjusts memory `strength` only for memories whose `goal_recall_log.recalled_at` falls inside the goal's lifespan window, by ×1.10 (n≥0.7), ×0.85 (n<0.3), or 1.0x (neutral band). Strength clamped to [0,1]. Hard-capped to one propagation per `(memory_id, goal_id)` pair via `UNIQUE` on the log.
6. Multiplier-explosion bound: integration test verifies the *final* score multiplier never exceeds 3.0x regardless of how many policies stack.
7. All existing tests pass (886 baseline). ~30 new tests cover: schema (FKs, CHECKs, indexes), lifecycle, stack-depth cap under concurrent push, recall integration, policy weighting, outcome propagation lifespan window, CLI roundtrips.

**Stretch (v0.39 target, NOT v0.38 success):** (a) Wilcoxon-paired statistical lift via a new `benchmarks/micro/paired_ab.py` harness (does not exist today); (b) sequential-learning trap-rate −10pp lift on the public benchmark. Requires a contract change to `benchmarks/sequential-learning/adapters/interface.mjs` adding `pushGoal/completeGoal` hooks, plus a separate decision on whether goal names track per-task trap categories (the agent does not know them at recall time, so a session-level goal cannot discriminate). Recorded as a follow-up; do **not** ship a worse number labelled as v0.38 success.

**Out of scope (deferred to v0.39+):**
- vlPFC interference suppression / multi-goal interference handling beyond simple tag overlap (RESEARCH.md mentions it; this plan does NOT implement it).
- Hierarchical multi-level goals beyond `level 0/1` (column stored, parent navigation flat in `hippo goal list`).
- REST/MCP session_id plumbing (`src/server.ts:399`, `/v1/recall`, MCP `recall` handler all stay env-driven from CLI; non-CLI callers do not see goal-stack boost in v0.38).
- OpenClaw plugin auto-tagging stored memories with active goals (separate plan).
- Sequential-learning trap-benchmark integration (see Stretch above).
- Cross-tenant goal visibility — goals are tenant-and-session scoped only.
- Auto-discovery of goal name from query text (NLP).

---

## Task layout

- Task 0 baseline.
- Task 1 schema (hardened).
- Tasks 2-5 goals API (types, push, depth-cap+race, lifecycle).
- Tasks 6-9 recall integration in CLI (auto-boost, policy, recall log, outcome propagation).
- Task 10 CLI surface for `hippo goal …`.
- Tasks 11-12 new micro-benchmark fixture + verification at p<0.05.
- Task 13 docs + ship.

Each task is one commit. Single PR at the end of Task 13.

---

### Task 0: Branch + verify baseline

**Step 1: Branch off master**

```bash
git checkout master
git pull
git checkout -b feat/b3-dlpfc-depth
git status
```

Expected: clean working tree, on `feat/b3-dlpfc-depth`.

**Step 2: Verify baseline schema version**

Run: `grep -n "CURRENT_SCHEMA_VERSION" src/db.ts`
Expected: `const CURRENT_SCHEMA_VERSION = 17;`

**Step 3: Verify MVP --goal flag exists**

Run: `grep -n "goalTag" src/cli.ts`
Expected: lines around 967-979 with `goalTag = flags['goal']` and the 1.5x multiplier loop.

**Step 4: Verify recall signature**

Run: `grep -n "export function recall" src/api.ts`
Expected: `export function recall(ctx: Context, opts: RecallOpts): RecallResult` at line ~126. The `RecallResult` is `{ results, total, tokens }`. Tests in this plan use `r.results` not `r`.

**Step 5: Run baseline tests**

Run: `npx vitest run`
Expected: all green (record the count — ~886).

**Step 6: Run baseline `dlpfc-goals` micro-fixture**

Run: `python benchmarks/micro/run.py --filter dlpfc-goals`
Expected: pass (the MVP boost works). Save the printout for the Task 11 baseline.

No commit. This task is pure baselining.

---

### Task 1: Schema migration v18 — hardened goal_stack + retrieval_policy + goal_recall_log

**Files:**
- Modify: `src/db.ts:24` (bump `CURRENT_SCHEMA_VERSION` to 18)
- Modify: `src/db.ts` (append migration v18 to `MIGRATIONS` array — the array currently ends after v17 around line 470; append before the closing `];`)
- Test: `tests/b3-goal-stack-migration.test.ts` (create)

**Schema design notes (addresses codex P2 schema-looseness):**
- `goal_stack` rows are tenant-and-session scoped. `tenant_id` is `NOT NULL DEFAULT 'default'` to align with the A5 pattern.
- `parent_goal_id` is a self-FK on `goal_stack(id)`. Null is allowed (level-0 root).
- `retrieval_policy.goal_id` FKs `goal_stack(id) ON DELETE CASCADE`.
- `goal_recall_log` carries `tenant_id` and `session_id` columns; FKs both `goal_stack(id)` and `memories(id)` `ON DELETE CASCADE`.
- `UNIQUE (memory_id, goal_id)` on `goal_recall_log` so the same `(memory, goal)` pair is logged at most once. Re-recall during the same goal lifespan upserts `recalled_at` and `score`.
- `outcome_score` constrained to `NULL` or `[0,1]`.
- `level` constrained to `[0,2]`.
- Index `(tenant_id, session_id, status, created_at)` covers the hottest read (active goals for current session).
- **Accepted P2 (codex v2):** `goal_stack.retrieval_policy_id` is plain `TEXT`, not a FK. The reverse FK `retrieval_policy.goal_id REFERENCES goal_stack(id) ON DELETE CASCADE` already cascades cleanly when a goal is deleted. The forward pointer is denormalized for read convenience (one row read instead of a JOIN). The risk: someone manually deleting a `retrieval_policy` row without nulling `goal_stack.retrieval_policy_id` leaves a soft-orphan pointer. v0.38 accepts this — `retrieval_policy` is only written through `pushGoalWithDb` in this codebase. v0.39 follow-up either adds a FK `REFERENCES retrieval_policy(id) ON DELETE SET NULL` or drops the column entirely and queries by reverse FK.

**Step 1: Write the failing test**

```ts
// tests/b3-goal-stack-migration.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';

describe('B3 schema migration v18', () => {
  it('migrates to schema version 18', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(18);
      expect(getCurrentSchemaVersion()).toBe(18);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates goal_stack with all required columns', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(goal_stack)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const required of [
        'id', 'session_id', 'tenant_id', 'goal_name', 'level', 'parent_goal_id',
        'status', 'success_condition', 'retrieval_policy_id',
        'created_at', 'completed_at', 'outcome_score',
      ]) {
        expect(names.has(required), `goal_stack.${required} missing`).toBe(true);
      }
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces status CHECK', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 0, 'bogus_status', new Date().toISOString());
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces level CHECK 0..2', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 5, 'active', new Date().toISOString());
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces outcome_score CHECK 0..1', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const insert = () => db.prepare(
        `INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at, outcome_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('g1', 's1', 'default', 'test', 0, 'completed', new Date().toISOString(), 1.5);
      expect(insert).toThrow(/CHECK|constraint/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates retrieval_policy + goal_recall_log with FKs and indexes', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      const policyCols = db.prepare(`PRAGMA table_info(retrieval_policy)`).all() as Array<{ name: string }>;
      const policyNames = new Set(policyCols.map((c) => c.name));
      for (const c of ['id', 'goal_id', 'policy_type', 'weight_schema_fit', 'weight_recency', 'weight_outcome', 'error_priority']) {
        expect(policyNames.has(c), `retrieval_policy.${c} missing`).toBe(true);
      }
      const logCols = db.prepare(`PRAGMA table_info(goal_recall_log)`).all() as Array<{ name: string }>;
      const logNames = new Set(logCols.map((c) => c.name));
      for (const c of ['id', 'goal_id', 'memory_id', 'tenant_id', 'session_id', 'recalled_at', 'score']) {
        expect(logNames.has(c), `goal_recall_log.${c} missing`).toBe(true);
      }
      const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const idxNames = new Set(idx.map((i) => i.name));
      expect(idxNames.has('idx_goal_stack_tenant_session_status')).toBe(true);
      expect(idxNames.has('idx_retrieval_policy_goal')).toBe(true);
      expect(idxNames.has('idx_goal_recall_log_goal')).toBe(true);
      expect(idxNames.has('uniq_goal_recall_log_memory_goal')).toBe(true);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('FKs cascade: deleting a goal deletes its policy and recall log rows', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-b3-mig-'));
    const db = openHippoDb(home);
    try {
      db.prepare(`
        INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind)
        VALUES ('m1','2026-04-29','2026-04-29',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')
      `).run();
      db.prepare(`INSERT INTO goal_stack (id, session_id, tenant_id, goal_name, level, status, created_at) VALUES ('g1','s1','default','t',0,'active',?)`).run(new Date().toISOString());
      db.prepare(`INSERT INTO retrieval_policy (id, goal_id, policy_type) VALUES ('rp1','g1','error-prioritized')`).run();
      db.prepare(`INSERT INTO goal_recall_log (goal_id, memory_id, tenant_id, session_id, recalled_at, score) VALUES ('g1','m1','default','s1',?,1.0)`).run(new Date().toISOString());

      db.prepare(`DELETE FROM goal_stack WHERE id = 'g1'`).run();

      expect((db.prepare(`SELECT COUNT(*) AS c FROM retrieval_policy`).get() as { c: number }).c).toBe(0);
      expect((db.prepare(`SELECT COUNT(*) AS c FROM goal_recall_log`).get() as { c: number }).c).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/b3-goal-stack-migration.test.ts`
Expected: 7 FAILs.

**Step 3: Implement migration v18**

In `src/db.ts`, change line 24:

```ts
const CURRENT_SCHEMA_VERSION = 18;
```

In `src/db.ts`, append to the `MIGRATIONS` array (immediately before the closing `];` after the v17 slack migration, around line 470):

```ts
  {
    version: 18,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goal_stack (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          goal_name TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 0
            CHECK (level BETWEEN 0 AND 2),
          parent_goal_id TEXT REFERENCES goal_stack(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK (status IN ('active','suspended','completed')),
          success_condition TEXT,
          retrieval_policy_id TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          outcome_score REAL
            CHECK (outcome_score IS NULL OR (outcome_score >= 0 AND outcome_score <= 1))
        );

        CREATE INDEX IF NOT EXISTS idx_goal_stack_tenant_session_status
          ON goal_stack(tenant_id, session_id, status, created_at);

        CREATE TABLE IF NOT EXISTS retrieval_policy (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          policy_type TEXT NOT NULL CHECK (policy_type IN
            ('schema-fit-biased','error-prioritized','recency-first','hybrid')),
          weight_schema_fit REAL NOT NULL DEFAULT 1.0,
          weight_recency REAL NOT NULL DEFAULT 1.0,
          weight_outcome REAL NOT NULL DEFAULT 1.0,
          error_priority REAL NOT NULL DEFAULT 1.0
        );

        CREATE INDEX IF NOT EXISTS idx_retrieval_policy_goal
          ON retrieval_policy(goal_id);

        CREATE TABLE IF NOT EXISTS goal_recall_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id TEXT NOT NULL REFERENCES goal_stack(id) ON DELETE CASCADE,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          session_id TEXT NOT NULL,
          recalled_at TEXT NOT NULL,
          score REAL NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_goal_recall_log_goal
          ON goal_recall_log(goal_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_goal_recall_log_memory_goal
          ON goal_recall_log(memory_id, goal_id);
      `);
    },
  },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/b3-goal-stack-migration.test.ts`
Expected: 7 PASS.

**Step 5: Run full suite — flush schema-pin breakage**

Run: `npx vitest run`
Expected: any test pinning `getSchemaVersion === 17` fails. Search and fix:

```bash
grep -rln "toBe(17)" tests/ | xargs grep -l "getSchemaVersion\|getCurrentSchemaVersion"
```

Bump those pins to `18` inline. Re-run; all green.

**Step 6: Commit**

```bash
git add src/db.ts tests/b3-goal-stack-migration.test.ts tests/<any-pin-bumps>.ts
git commit -m "feat(db): schema v18 - goal_stack + retrieval_policy + recall log (FKs+CHECKs)"
```

---

### Task 2: Goal types + handoff helpers

**Files:**
- Create: `src/goals.ts`
- Test: `tests/b3-goal-types.test.ts`

**Step 1: Write the failing test**

```ts
// tests/b3-goal-types.test.ts
import { describe, it, expect } from 'vitest';
import { rowToGoal, type GoalRow } from '../src/goals.js';

describe('rowToGoal', () => {
  it('maps row → Goal with required fields', () => {
    const row: GoalRow = {
      id: 'g1',
      session_id: 's1',
      tenant_id: 'default',
      goal_name: 'review auth code',
      level: 0,
      parent_goal_id: null,
      status: 'active',
      success_condition: null,
      retrieval_policy_id: null,
      created_at: '2026-04-29T00:00:00.000Z',
      completed_at: null,
      outcome_score: null,
    };
    const goal = rowToGoal(row);
    expect(goal.id).toBe('g1');
    expect(goal.sessionId).toBe('s1');
    expect(goal.tenantId).toBe('default');
    expect(goal.goalName).toBe('review auth code');
    expect(goal.status).toBe('active');
    expect(goal.parentGoalId).toBeUndefined();
    expect(goal.completedAt).toBeUndefined();
  });

  it('preserves completed goals with outcome_score', () => {
    const row: GoalRow = {
      id: 'g2',
      session_id: 's1',
      tenant_id: 'default',
      goal_name: 'done',
      level: 0,
      parent_goal_id: null,
      status: 'completed',
      success_condition: null,
      retrieval_policy_id: null,
      created_at: '2026-04-29T00:00:00.000Z',
      completed_at: '2026-04-29T01:00:00.000Z',
      outcome_score: 0.85,
    };
    const goal = rowToGoal(row);
    expect(goal.status).toBe('completed');
    expect(goal.completedAt).toBe('2026-04-29T01:00:00.000Z');
    expect(goal.outcomeScore).toBe(0.85);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/b3-goal-types.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement src/goals.ts (types only)**

```ts
// src/goals.ts
import { randomUUID } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';

export type GoalStatus = 'active' | 'suspended' | 'completed';
export type PolicyType = 'schema-fit-biased' | 'error-prioritized' | 'recency-first' | 'hybrid';

export interface GoalRow {
  id: string;
  session_id: string;
  tenant_id: string;
  goal_name: string;
  level: number;
  parent_goal_id: string | null;
  status: GoalStatus;
  success_condition: string | null;
  retrieval_policy_id: string | null;
  created_at: string;
  completed_at: string | null;
  outcome_score: number | null;
}

export interface Goal {
  id: string;
  sessionId: string;
  tenantId: string;
  goalName: string;
  level: number;
  parentGoalId?: string;
  status: GoalStatus;
  successCondition?: string;
  retrievalPolicyId?: string;
  createdAt: string;
  completedAt?: string;
  outcomeScore?: number;
}

export interface RetrievalPolicy {
  id: string;
  goalId: string;
  policyType: PolicyType;
  weightSchemaFit: number;
  weightRecency: number;
  weightOutcome: number;
  errorPriority: number;
}

export const MAX_ACTIVE_GOAL_DEPTH = 3;
export const MAX_FINAL_MULTIPLIER = 3.0;

export function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    goalName: row.goal_name,
    level: row.level,
    parentGoalId: row.parent_goal_id ?? undefined,
    status: row.status,
    successCondition: row.success_condition ?? undefined,
    retrievalPolicyId: row.retrieval_policy_id ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    outcomeScore: row.outcome_score ?? undefined,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/b3-goal-types.test.ts`
Expected: 2 PASS.

**Step 5: Commit**

```bash
git add src/goals.ts tests/b3-goal-types.test.ts
git commit -m "feat(goals): Goal/RetrievalPolicy types + rowToGoal mapper"
```

---

### Task 3: pushGoal — single transaction, parent-first insert

**Files:**
- Modify: `src/goals.ts` (add pushGoal/pushGoalWithDb)
- Test: `tests/b3-goal-push.test.ts`

**Correctness notes (addresses codex P1 FK ordering + P2 race):**
- Insert into `goal_stack` first, then `retrieval_policy`. The plan v1 inserted policy first; that fails under `PRAGMA foreign_keys = ON` because the policy's FK to `goal_stack(id)` cannot be satisfied yet.
- Wrap the entire push (depth-cap read, possible suspend, `goal_stack` insert, optional `retrieval_policy` insert, `retrieval_policy_id` UPDATE on `goal_stack`) in `BEGIN IMMEDIATE ... COMMIT`. SQLite's `BEGIN IMMEDIATE` acquires a write lock so two concurrent pushes serialize, closing the TOCTOU window.

**Step 1: Write the failing test**

```ts
// tests/b3-goal-push.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { pushGoal, getActiveGoals } from '../src/goals.js';

describe('pushGoal + getActiveGoals', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-push-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('push then list returns the new goal as active', () => {
    const goal = pushGoal(root, {
      sessionId: 's1',
      tenantId: 'default',
      goalName: 'review auth code',
    });
    expect(goal.id).toMatch(/^g_/);
    expect(goal.status).toBe('active');

    const active = getActiveGoals(root, { sessionId: 's1', tenantId: 'default' });
    expect(active).toHaveLength(1);
    expect(active[0].goalName).toBe('review auth code');
  });

  it('isolates goals across sessions and tenants', () => {
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A' });
    pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'B' });
    pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'C' });
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })[0].goalName).toBe('A');
    expect(getActiveGoals(root, { sessionId: 's2', tenantId: 'default' })[0].goalName).toBe('B');
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 't2' })[0].goalName).toBe('C');
  });

  it('attaches retrieval policy when provided (no FK error)', () => {
    const g = pushGoal(root, {
      sessionId: 's1',
      tenantId: 'default',
      goalName: 'with policy',
      policy: { policyType: 'error-prioritized', errorPriority: 2.0 },
    });
    expect(g.retrievalPolicyId).toBeDefined();
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })[0].retrievalPolicyId).toBe(g.retrievalPolicyId);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/b3-goal-push.test.ts`
Expected: FAIL — pushGoal not exported.

**Step 3: Implement pushGoal + getActiveGoals**

Append to `src/goals.ts`:

```ts
export interface PushGoalOpts {
  sessionId: string;
  tenantId: string;
  goalName: string;
  level?: number;
  parentGoalId?: string;
  successCondition?: string;
  policy?: {
    policyType: PolicyType;
    weightSchemaFit?: number;
    weightRecency?: number;
    weightOutcome?: number;
    errorPriority?: number;
  };
}

export function pushGoal(hippoRoot: string, opts: PushGoalOpts): Goal {
  const db = openHippoDb(hippoRoot);
  try {
    return pushGoalWithDb(db, opts);
  } finally {
    closeHippoDb(db);
  }
}

export function pushGoalWithDb(db: DatabaseSyncLike, opts: PushGoalOpts): Goal {
  const id = `g_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();
  let policyId: string | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Depth cap: count active for (tenant, session); suspend oldest if at cap.
    const activeCount = (db.prepare(`
      SELECT COUNT(*) AS c
      FROM goal_stack
      WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    `).get(opts.tenantId, opts.sessionId) as { c: number }).c;

    if (activeCount >= MAX_ACTIVE_GOAL_DEPTH) {
      const overflow = activeCount - MAX_ACTIVE_GOAL_DEPTH + 1;
      db.prepare(`
        UPDATE goal_stack
        SET status = 'suspended'
        WHERE id IN (
          SELECT id FROM goal_stack
          WHERE tenant_id = ? AND session_id = ? AND status = 'active'
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(opts.tenantId, opts.sessionId, overflow);
    }

    // Parent goal_stack row first (FK target).
    db.prepare(`
      INSERT INTO goal_stack
        (id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
         success_condition, retrieval_policy_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
    `).run(
      id, opts.sessionId, opts.tenantId, opts.goalName,
      opts.level ?? 0, opts.parentGoalId ?? null,
      opts.successCondition ?? null, createdAt,
    );

    // Optional policy row, then point goal_stack.retrieval_policy_id at it.
    if (opts.policy) {
      policyId = `rp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(`
        INSERT INTO retrieval_policy
          (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        policyId, id, opts.policy.policyType,
        opts.policy.weightSchemaFit ?? 1.0,
        opts.policy.weightRecency ?? 1.0,
        opts.policy.weightOutcome ?? 1.0,
        opts.policy.errorPriority ?? 1.0,
      );
      db.prepare(`UPDATE goal_stack SET retrieval_policy_id = ? WHERE id = ?`).run(policyId, id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    id,
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    goalName: opts.goalName,
    level: opts.level ?? 0,
    parentGoalId: opts.parentGoalId,
    status: 'active',
    successCondition: opts.successCondition,
    retrievalPolicyId: policyId ?? undefined,
    createdAt,
  };
}

export interface GetActiveGoalsOpts {
  sessionId: string;
  tenantId: string;
}

export function getActiveGoals(hippoRoot: string, opts: GetActiveGoalsOpts): Goal[] {
  const db = openHippoDb(hippoRoot);
  try {
    return getActiveGoalsWithDb(db, opts);
  } finally {
    closeHippoDb(db);
  }
}

export function getActiveGoalsWithDb(db: DatabaseSyncLike, opts: GetActiveGoalsOpts): Goal[] {
  const rows = db.prepare(`
    SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `).all(opts.tenantId, opts.sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/b3-goal-push.test.ts`
Expected: 3 PASS.

**Step 5: Commit**

```bash
git add src/goals.ts tests/b3-goal-push.test.ts
git commit -m "feat(goals): pushGoal in BEGIN IMMEDIATE - parent before policy, depth-capped"
```

---

### Task 4: Stack-depth cap — explicit concurrency test

**Files:**
- Test: `tests/b3-goal-depth-cap.test.ts`

This task only adds tests; the implementation is already in Task 3 (depth cap inside `BEGIN IMMEDIATE`). Validate no >3 active goals can survive concurrent push.

**Step 1: Write the failing test**

```ts
// tests/b3-goal-depth-cap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { pushGoal, getActiveGoals, MAX_ACTIVE_GOAL_DEPTH } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('goal stack depth cap', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-cap-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exposes MAX_ACTIVE_GOAL_DEPTH = 3', () => {
    expect(MAX_ACTIVE_GOAL_DEPTH).toBe(3);
  });

  it('auto-suspends the oldest active goal when pushing the 4th', () => {
    const g1 = pushGoal(root, { ...ctx, goalName: 'oldest' });
    pushGoal(root, { ...ctx, goalName: 'middle' });
    pushGoal(root, { ...ctx, goalName: 'recent' });
    pushGoal(root, { ...ctx, goalName: 'newest' });

    const active = getActiveGoals(root, ctx);
    expect(active).toHaveLength(3);
    expect(active.map((g) => g.goalName)).toEqual(['middle', 'recent', 'newest']);

    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g1.id) as { status: string };
      expect(row.status).toBe('suspended');
    } finally {
      closeHippoDb(db);
    }
  });

  it('cap is per-(tenant, session)', () => {
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A1' });
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A2' });
    pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'A3' });
    pushGoal(root, { sessionId: 's2', tenantId: 'default', goalName: 'B1' });
    pushGoal(root, { sessionId: 's1', tenantId: 't2', goalName: 'C1' });
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 'default' })).toHaveLength(3);
    expect(getActiveGoals(root, { sessionId: 's2', tenantId: 'default' })).toHaveLength(1);
    expect(getActiveGoals(root, { sessionId: 's1', tenantId: 't2' })).toHaveLength(1);
  });

  it('serialized pushes never leave more than 3 active (post-Task-3 BEGIN IMMEDIATE)', () => {
    // Sequential is enough to verify the invariant — node:sqlite is in-process,
    // and BEGIN IMMEDIATE serializes through SQLite's write lock. This guards
    // against regressions where someone strips the transaction wrapper.
    for (let i = 0; i < 10; i++) {
      pushGoal(root, { ...ctx, goalName: `g${i}` });
    }
    expect(getActiveGoals(root, ctx)).toHaveLength(3);
    const db = openHippoDb(root);
    try {
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM goal_stack`).get() as { c: number }).c;
      expect(total).toBe(10);
    } finally {
      closeHippoDb(db);
    }
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/b3-goal-depth-cap.test.ts`
Expected: 4 PASS (Task 3 implementation already covers this).

**Step 3: Commit**

```bash
git add tests/b3-goal-depth-cap.test.ts
git commit -m "test(goals): cap-3 invariant under sequential and (de-facto serial) push"
```

---

### Task 5: completeGoal + suspendGoal + resumeGoal — lifespan-windowed propagation

**Files:**
- Modify: `src/goals.ts` (add lifecycle helpers; completeGoal applies windowed propagation)
- Test: `tests/b3-goal-lifecycle.test.ts`
- Test: `tests/b3-outcome-propagation.test.ts`

**Correctness notes (addresses codex P1 outcome propagation + P2 weak test):**
- `completeGoal(goalId, {outcomeScore})` updates `goal_stack` row, then if `outcomeScore` is non-null AND outside the [0.3, 0.7) neutral band, walks `goal_recall_log` for THAT goal where `recalled_at BETWEEN goal.created_at AND goal.completed_at`. Adjusts `memories.strength` once per `(memory_id, goal_id)` pair (UNIQUE index already enforces single log row per pair, so this is safe).
- Multiplier ×1.10 on positive (n≥0.7), ×0.85 on negative (n<0.3). Strength clamped to [0,1].
- The lifespan window prevents memories that were merely *logged-against* a goal long ago (without genuine retrieval during its life) from being re-multiplied. Combined with the UNIQUE log row, propagation is bounded.

**Step 1: Write the failing tests** (lifecycle)

```ts
// tests/b3-goal-lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { pushGoal, completeGoal, suspendGoal, resumeGoal, getActiveGoals } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('goal lifecycle', () => {
  let root: string;
  const ctx = { sessionId: 's1', tenantId: 'default' };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-life-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('completeGoal sets status, completed_at, outcome_score', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'work' });
    completeGoal(root, g.id, { outcomeScore: 0.85 });
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status, completed_at, outcome_score FROM goal_stack WHERE id = ?`).get(g.id) as { status: string; completed_at: string; outcome_score: number };
      expect(row.status).toBe('completed');
      expect(row.completed_at).toBeTruthy();
      expect(row.outcome_score).toBe(0.85);
    } finally {
      closeHippoDb(db);
    }
    expect(getActiveGoals(root, ctx)).toHaveLength(0);
  });

  it('suspend/resume cycles status; cap applies on resume', () => {
    const a = pushGoal(root, { ...ctx, goalName: 'a' });
    pushGoal(root, { ...ctx, goalName: 'b' });
    pushGoal(root, { ...ctx, goalName: 'c' });
    suspendGoal(root, a.id);
    expect(getActiveGoals(root, ctx)).toHaveLength(2);
    pushGoal(root, { ...ctx, goalName: 'd' });
    expect(getActiveGoals(root, ctx)).toHaveLength(3);
    resumeGoal(root, a.id);
    const names = getActiveGoals(root, ctx).map((g) => g.goalName).sort();
    expect(names).toContain('a');
    expect(names).toHaveLength(3);
  });

  it('completeGoal on a suspended goal still works', () => {
    const g = pushGoal(root, { ...ctx, goalName: 'sus-then-done' });
    suspendGoal(root, g.id);
    completeGoal(root, g.id, { outcomeScore: 0.5 });
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT status FROM goal_stack WHERE id = ?`).get(g.id) as { status: string };
      expect(row.status).toBe('completed');
    } finally {
      closeHippoDb(db);
    }
  });
});
```

**Step 2: Implement lifecycle helpers**

Append to `src/goals.ts`:

```ts
const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.10;
const STRENGTH_DECAY = 0.85;

export interface CompleteGoalOpts {
  outcomeScore?: number;
}

export function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOpts): void {
  const db = openHippoDb(hippoRoot);
  try {
    const completedAt = new Date().toISOString();
    const score = opts.outcomeScore ?? null;

    db.exec('BEGIN IMMEDIATE');
    try {
      const goalRow = db.prepare(
        `SELECT created_at FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { created_at: string } | undefined;
      if (!goalRow) {
        db.exec('COMMIT');
        return;
      }

      db.prepare(`
        UPDATE goal_stack
        SET status = 'completed', completed_at = ?, outcome_score = ?
        WHERE id = ?
      `).run(completedAt, score, goalId);

      if (score !== null) {
        let multiplier = 1;
        if (score >= POSITIVE_OUTCOME_THRESHOLD) multiplier = STRENGTH_BOOST;
        else if (score < NEGATIVE_OUTCOME_THRESHOLD) multiplier = STRENGTH_DECAY;

        if (multiplier !== 1) {
          // Lifespan window: only memories whose recall happened during this
          // goal's active life. UNIQUE(memory_id, goal_id) guarantees one
          // adjustment per (memory, goal) pair.
          db.prepare(`
            UPDATE memories
            SET strength = MIN(1.0, MAX(0.0, strength * ?))
            WHERE id IN (
              SELECT memory_id FROM goal_recall_log
              WHERE goal_id = ?
                AND recalled_at >= ?
                AND recalled_at <= ?
            )
          `).run(multiplier, goalId, goalRow.created_at, completedAt);
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function suspendGoal(hippoRoot: string, goalId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE goal_stack SET status = 'suspended' WHERE id = ? AND status = 'active'`).run(goalId);
  } finally {
    closeHippoDb(db);
  }
}

export function resumeGoal(hippoRoot: string, goalId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(
        `SELECT session_id, tenant_id, status FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { session_id: string; tenant_id: string; status: string } | undefined;
      if (!row || row.status !== 'suspended') {
        db.exec('COMMIT');
        return;
      }

      const activeCount = (db.prepare(`
        SELECT COUNT(*) AS c FROM goal_stack
        WHERE tenant_id = ? AND session_id = ? AND status = 'active'
      `).get(row.tenant_id, row.session_id) as { c: number }).c;

      if (activeCount >= MAX_ACTIVE_GOAL_DEPTH) {
        const overflow = activeCount - MAX_ACTIVE_GOAL_DEPTH + 1;
        db.prepare(`
          UPDATE goal_stack
          SET status = 'suspended'
          WHERE id IN (
            SELECT id FROM goal_stack
            WHERE tenant_id = ? AND session_id = ? AND status = 'active'
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(row.tenant_id, row.session_id, overflow);
      }

      db.prepare(`UPDATE goal_stack SET status = 'active' WHERE id = ?`).run(goalId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    closeHippoDb(db);
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/b3-goal-lifecycle.test.ts`
Expected: 3 PASS.

**Step 4: Outcome propagation tests** (separate file because they need recall to populate `goal_recall_log` — those land in Task 8 properly. For now, write tests that *seed* `goal_recall_log` directly to verify the windowed propagation logic in isolation.)

```ts
// tests/b3-outcome-propagation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

function readStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    return (db.prepare(`SELECT strength FROM memories WHERE id = ?`).get(memId) as { strength: number }).strength;
  } finally {
    closeHippoDb(db);
  }
}

function seedRecallLog(root: string, goalId: string, memoryId: string, recalledAt: string) {
  const db = openHippoDb(root);
  try {
    db.prepare(
      `INSERT INTO goal_recall_log (goal_id, memory_id, tenant_id, session_id, recalled_at, score) VALUES (?, ?, 'default', 's1', ?, 1.0)`,
    ).run(goalId, memoryId, recalledAt);
  } finally {
    closeHippoDb(db);
  }
}

describe('completeGoal lifespan-windowed propagation', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-out-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('outcome >= 0.7 boosts memories recalled within the goal lifespan', () => {
    const m = remember(ctx(root), { content: 'lesson', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(readStrength(root, m.id)).toBeGreaterThan(before);
  });

  it('outcome < 0.3 decays memories within window', () => {
    const m = remember(ctx(root), { content: 'misleading', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.1 });
    expect(readStrength(root, m.id)).toBeLessThan(before);
  });

  it('neutral band [0.3, 0.7) leaves strength unchanged', () => {
    const m = remember(ctx(root), { content: 'neutral', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, new Date().toISOString());
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.5 });
    expect(readStrength(root, m.id)).toBe(before);
  });

  it('memories recalled BEFORE the goal lifespan are NOT propagated', () => {
    const m = remember(ctx(root), { content: 'pre-goal', tags: ['rfx'] });
    // Seed a log row dated yesterday — before any goal exists.
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    seedRecallLog(root, g.id, m.id, yesterday); // outside lifespan
    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(readStrength(root, m.id)).toBe(before); // no change
  });

  it('UNIQUE(memory_id, goal_id) prevents double-propagation if the log is poked twice', () => {
    const m = remember(ctx(root), { content: 'once', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName: 'rfx' });
    const now = new Date().toISOString();
    seedRecallLog(root, g.id, m.id, now);
    expect(() => seedRecallLog(root, g.id, m.id, now)).toThrow(/UNIQUE/i);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    // Strength multiplied by 1.10 once, not twice.
  });
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/b3-outcome-propagation.test.ts`
Expected: 5 PASS.

**Step 6: Commit**

```bash
git add src/goals.ts tests/b3-goal-lifecycle.test.ts tests/b3-outcome-propagation.test.ts
git commit -m "feat(goals): lifecycle + lifespan-windowed outcome propagation"
```

---

### Task 6: Hook recall (CLI post-hoc) into the active goal stack

**Files:**
- Modify: `src/cli.ts:967-979` (extend the existing dlPFC block)
- Test: `tests/b3-recall-active-goals.test.ts`

**Architectural notes (addresses codex P2 src/server.ts:399 + P1 API surface):**
- The boost stays in `src/cli.ts` post-hoc, mirroring the MVP's location at lines 967-979. **Do NOT touch `src/api.ts:recall()` or `RecallOpts`.** This means MCP/REST callers do not get the boost in v0.38; they continue to use the unmodified `recall(ctx, opts)` path. v0.39 follow-up plumbs `session_id` through `Context` if/when it becomes a first-class concept.
- The CLI reads `HIPPO_SESSION_ID` and `HIPPO_TENANT` env vars (consistent with the existing `--tenant-id` / `HIPPO_TENANT` pattern). New flag `--session-id <id>` overrides the env. When neither is set, the goal-stack boost is a no-op (the MVP `--goal <tag>` flag remains the explicit override).
- The boost runs AFTER the existing MVP `--goal <tag>` block so an explicit `--goal` always wins.

**Step 1: Write the failing test**

```ts
// tests/b3-recall-active-goals.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

function recallCli(root: string, query: string, env: Record<string, string>): string[] {
  const raw = execFileSync('node', [CLI, 'recall', query, '--json', '--budget', '2000'], {
    env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', ...env },
    encoding: 'utf8',
  });
  const start = raw.indexOf('{');
  const parsed = JSON.parse(raw.slice(start));
  return (parsed.results ?? []).map((r: { content: string }) => r.content);
}

describe('cli recall + active goal stack', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-cli-recall-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('without active goals (no HIPPO_SESSION_ID), top-3 unchanged from baseline', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const top = recallCli(root, 'auth migration', {});
    expect(top.slice(0, 3).some((c) => c.includes('plan note'))).toBe(true);
  });

  it('with HIPPO_SESSION_ID set and an active goal whose name matches a tag, tagged memories surface in top-3', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    pushGoal(root, { sessionId: 's-cli-1', tenantId: 'default', goalName: 'auth-rewrite' });

    const top = recallCli(root, 'auth migration', { HIPPO_SESSION_ID: 's-cli-1' });
    expect(top.slice(0, 2).some((c) => c.includes('marker tagged A'))).toBe(true);
    expect(top.slice(0, 2).some((c) => c.includes('marker tagged B'))).toBe(true);
  });

  it('completed goals do not affect ranking (test asserts ORDER, not just length)', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    const g = pushGoal(root, { sessionId: 's-cli-1', tenantId: 'default', goalName: 'auth-rewrite' });
    completeGoal(root, g.id, { outcomeScore: 1.0 });

    const top = recallCli(root, 'auth migration', { HIPPO_SESSION_ID: 's-cli-1' });
    // After completion, the active-goal boost should NOT fire. So the marker
    // need not be #1 — assert the same baseline ordering as the no-session case.
    expect(top.slice(0, 1).some((c) => c.includes('plan note'))).toBe(true);
  });

  it('explicit --goal still works as a manual override (MVP behavior preserved)', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: 'cli' };
    remember(ctx, { content: 'plan note one for the auth migration' });
    remember(ctx, { content: 'plan note two for the auth migration' });
    remember(ctx, { content: 'plan note three for the auth migration' });
    remember(ctx, { content: 'marker tagged A: auth migration step', tags: ['auth-rewrite'] });
    remember(ctx, { content: 'marker tagged B: auth migration step', tags: ['auth-rewrite'] });

    const raw = execFileSync('node', [CLI, 'recall', 'auth migration', '--goal', 'auth-rewrite', '--json'], {
      env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
    const top = (parsed.results as Array<{ content: string }>).slice(0, 2);
    expect(top.some((r) => r.content.includes('marker tagged'))).toBe(true);
  });
});
```

**Step 2: Build + run test to verify it fails**

```bash
npm run build
npx vitest run tests/b3-recall-active-goals.test.ts
```

Expected: tests 2 and 3 FAIL — no auto-boost from goal_stack yet.

**Step 3: Extend the dlPFC block in src/cli.ts**

In `src/cli.ts:967-979`, immediately after the existing `--goal <tag>` block, add:

```ts
// dlPFC depth (B3, v0.38). When HIPPO_SESSION_ID is set and the (tenant, session)
// has active goals, boost memories whose tags overlap any active goal's name.
// Final multiplier is hard-capped at MAX_FINAL_MULTIPLIER (3.0x). Each boosted
// (memory, goal) pair is logged into goal_recall_log for outcome propagation.
const sessionId = (flags['session-id'] ?? process.env.HIPPO_SESSION_ID ?? '').toString().trim();
const tenantIdForGoals = (flags['tenant-id'] ?? process.env.HIPPO_TENANT ?? 'default').toString().trim();
if (sessionId && goalTag === '') {
  // Imports at top: import { getActiveGoalsWithDb, MAX_FINAL_MULTIPLIER } from './goals.js';
  // Re-use the same db handle the recall path opened, OR open one here.
  const dbForGoals = openHippoDb(homeRoot);
  try {
    const active = getActiveGoalsWithDb(dbForGoals, { sessionId, tenantId: tenantIdForGoals });
    if (active.length > 0) {
      const goalsByTag = new Map(active.map((g) => [g.goalName, g]));
      results = results
        .map((r) => {
          const tags = r.entry.tags ?? [];
          const matches = tags.filter((t) => goalsByTag.has(t));
          if (matches.length === 0) return r;
          // Base 2.0x for first match, +0.5x per additional, capped at 3.0x.
          const rawMul = Math.min(2.0 + 0.5 * (matches.length - 1), MAX_FINAL_MULTIPLIER);
          const multiplier = Math.min(rawMul, MAX_FINAL_MULTIPLIER);
          return { ...r, score: r.score * multiplier, _goalMatches: matches };
        })
        .sort((a, b) => b.score - a.score);

      // Log top-K boosted recalls. Use INSERT OR IGNORE because UNIQUE(memory_id, goal_id)
      // means a re-recall during the same goal life is a no-op.
      const recalledAt = new Date().toISOString();
      const insertLog = dbForGoals.prepare(`
        INSERT OR IGNORE INTO goal_recall_log
          (goal_id, memory_id, tenant_id, session_id, recalled_at, score)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const r of results.slice(0, limit)) {
        const matches: string[] | undefined = (r as { _goalMatches?: string[] })._goalMatches;
        if (!matches) continue;
        for (const tag of matches) {
          const goal = goalsByTag.get(tag)!;
          insertLog.run(goal.id, r.entry.id, tenantIdForGoals, sessionId, recalledAt, r.score);
        }
      }
    }
  } finally {
    closeHippoDb(dbForGoals);
  }
}
```

(Adapt variable names — `homeRoot`, `results`, `limit`, `flags`, `goalTag` — to the actual names in the existing CLI block. Read the full block before editing to avoid clobbering.)

**Step 4: Add `--session-id <id>` to flag parsing + help text**

Find the `--goal <tag>` help entry (around line 4765) and add right after:

```
    --session-id <id>      Session identifier for dlPFC goal-stack boost.
                           Defaults to $HIPPO_SESSION_ID. When set and the
                           (tenant, session) has active goals (see
                           `hippo goal push`), recall auto-boosts memories
                           whose tags match an active goal name. Boost stacks
                           on top of base BM25 score, capped at 3.0x.
```

**Step 5: Build and re-run tests**

```bash
npm run build
npx vitest run tests/b3-recall-active-goals.test.ts
```

Expected: 4 PASS.

**Step 6: Run full suite**

```bash
npx vitest run
```

Expected: all green.

**Step 7: Commit**

```bash
git add src/cli.ts tests/b3-recall-active-goals.test.ts
git commit -m "feat(cli): dlPFC depth - HIPPO_SESSION_ID auto-boost + recall log"
```

---

### Task 7: Retrieval policy weighting — hard-capped final multiplier

**Files:**
- Modify: `src/cli.ts` (extend the boost block from Task 6 to read the policy)
- Test: `tests/b3-retrieval-policy.test.ts`

**Correctness notes (addresses codex P1 multiplier explosion):**
- Policy multiplier composes onto the base goal-tag multiplier. The composed result is then clamped to `MAX_FINAL_MULTIPLIER = 3.0x` BEFORE applying to score. Even if `errorPriority = 9.0` and base = 3.0x, final cannot exceed 3.0x.
- Tested explicitly with an `errorPriority: 5.0` policy.

**Step 1: Write the failing test**

```ts
// tests/b3-retrieval-policy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

function recallCli(root: string, query: string, sessionId: string): Array<{ content: string; score: number }> {
  const raw = execFileSync('node', [CLI, 'recall', query, '--json', '--budget', '4000'], {
    env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: sessionId },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
  return parsed.results ?? [];
}

describe('retrieval policy', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-pol-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('error-prioritized policy ranks error-tagged > non-error within same goal', () => {
    remember(ctx(root), { content: 'note one about auth refactor', tags: ['auth-rewrite'] });
    remember(ctx(root), { content: 'lesson learned during auth refactor: bare except handler caused a bug', tags: ['auth-rewrite', 'error'] });
    remember(ctx(root), { content: 'note two about auth refactor', tags: ['auth-rewrite'] });

    pushGoal(root, {
      sessionId: 's-p1', tenantId: 'default',
      goalName: 'auth-rewrite',
      policy: { policyType: 'error-prioritized', errorPriority: 3.0 },
    });

    const top = recallCli(root, 'auth refactor', 's-p1');
    expect(top[0].content).toContain('lesson learned');
  });

  it('final multiplier never exceeds 3.0x even with extreme policy weights', () => {
    // Read base score for one memory with no goal active.
    remember(ctx(root), { content: 'high-error lesson', tags: ['plan-x', 'error'] });
    // Baseline: no session → no boost.
    const base = recallCli(root, 'high-error lesson', '');
    const baseScore = base[0]?.score ?? 1.0;

    pushGoal(root, {
      sessionId: 's-p2', tenantId: 'default',
      goalName: 'plan-x',
      policy: { policyType: 'error-prioritized', errorPriority: 9.0 },
    });
    const boosted = recallCli(root, 'high-error lesson', 's-p2');
    const boostedScore = boosted[0]?.score ?? 0;

    // Allow tiny floating-point slop above 3.0x base.
    expect(boostedScore / baseScore).toBeLessThanOrEqual(3.01);
    expect(boostedScore / baseScore).toBeGreaterThan(1.5); // and the boost did fire
  });
});
```

**Step 2: Build + run test to verify it fails**

```bash
npm run build
npx vitest run tests/b3-retrieval-policy.test.ts
```

Expected: test 2 FAIL — no policy reading / no cap applied.

**Step 3: Extend the boost block in src/cli.ts**

Replace the multiplier loop from Task 6 with policy-aware logic:

```ts
// (already imported MAX_FINAL_MULTIPLIER from Task 6)
import type { RetrievalPolicy } from './goals.js';

// inside the active-goals block, before the .map((r) => ...):
const policiesByGoalId = new Map<string, RetrievalPolicy>();
for (const g of active) {
  if (!g.retrievalPolicyId) continue;
  const row = dbForGoals.prepare(`
    SELECT id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority
    FROM retrieval_policy WHERE id = ?
  `).get(g.retrievalPolicyId) as {
    id: string; goal_id: string; policy_type: RetrievalPolicy['policyType'];
    weight_schema_fit: number; weight_recency: number; weight_outcome: number; error_priority: number;
  } | undefined;
  if (row) {
    policiesByGoalId.set(g.id, {
      id: row.id, goalId: row.goal_id, policyType: row.policy_type,
      weightSchemaFit: row.weight_schema_fit, weightRecency: row.weight_recency,
      weightOutcome: row.weight_outcome, errorPriority: row.error_priority,
    });
  }
}

// in the .map() arm where matches.length > 0:
let multiplier = Math.min(2.0 + 0.5 * (matches.length - 1), MAX_FINAL_MULTIPLIER);
for (const tag of matches) {
  const goal = goalsByTag.get(tag)!;
  const policy = policiesByGoalId.get(goal.id);
  if (!policy) continue;
  const tags = r.entry.tags ?? [];
  if (policy.policyType === 'error-prioritized' && tags.includes('error')) {
    multiplier *= policy.errorPriority;
  } else if (policy.policyType === 'schema-fit-biased') {
    // Linearly weights schema_fit in [0,1] up to (weightSchemaFit)x. Default 1.0
    // (no-op). Avoids the v1 plan's confusing `1 + (w-1) * fit` formulation.
    multiplier *= 1.0 + Math.max(0, policy.weightSchemaFit - 1.0) * (r.entry.schemaFit ?? 0.5);
  } else if (policy.policyType === 'recency-first') {
    multiplier *= policy.weightRecency;
  } else if (policy.policyType === 'hybrid') {
    multiplier *= policy.weightOutcome;
  }
}
multiplier = Math.min(multiplier, MAX_FINAL_MULTIPLIER); // hard cap
return { ...r, score: r.score * multiplier, _goalMatches: matches };
```

**Step 4: Run tests**

```bash
npm run build
npx vitest run tests/b3-retrieval-policy.test.ts
```

Expected: 2 PASS.

**Step 5: Run full suite**

```bash
npx vitest run
```

Expected: all green.

**Step 6: Commit**

```bash
git add src/cli.ts tests/b3-retrieval-policy.test.ts
git commit -m "feat(cli): retrieval policy weighting with 3.0x final multiplier cap"
```

---

### Task 8: goal_recall_log — verify capture from real recall

**Files:**
- Test: `tests/b3-goal-recall-log.test.ts`

The Task 6 implementation already inserts into `goal_recall_log` from the CLI boost block. This task adds an end-to-end test that verifies the log captures real recalls (not just seeded rows).

**Step 1: Write the test**

```ts
// tests/b3-goal-recall-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

describe('goal_recall_log captured from real CLI recall', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-recall-log-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('top-K boosted memories land in goal_recall_log with the active goal', () => {
    const m1 = remember(ctx(root), { content: 'lesson on auth refactor', tags: ['auth-rewrite'] });
    const g = pushGoal(root, { sessionId: 's-log-1', tenantId: 'default', goalName: 'auth-rewrite' });

    execFileSync('node', [CLI, 'recall', 'auth refactor', '--json', '--budget', '2000'], {
      env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-log-1' },
      encoding: 'utf8',
    });

    const db = openHippoDb(root);
    try {
      const rows = db.prepare(`SELECT goal_id, memory_id FROM goal_recall_log WHERE goal_id = ?`).all(g.id) as Array<{ goal_id: string; memory_id: string }>;
      expect(rows.some((r) => r.memory_id === m1.id)).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('no log row is written when no active goal matches', () => {
    remember(ctx(root), { content: 'unrelated note' });
    pushGoal(root, { sessionId: 's-log-2', tenantId: 'default', goalName: 'auth-rewrite' });

    execFileSync('node', [CLI, 'recall', 'unrelated', '--json'], {
      env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-log-2' },
      encoding: 'utf8',
    });

    const db = openHippoDb(root);
    try {
      const rows = db.prepare(`SELECT COUNT(*) AS c FROM goal_recall_log`).get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});
```

**Step 2: Run**

```bash
npm run build
npx vitest run tests/b3-goal-recall-log.test.ts
```

Expected: 2 PASS.

**Step 3: Commit**

```bash
git add tests/b3-goal-recall-log.test.ts
git commit -m "test(cli): goal_recall_log captures real CLI recall under active goal"
```

---

### Task 9: Outcome propagation — end-to-end through real recall

**Files:**
- Test: `tests/b3-outcome-end-to-end.test.ts`

Task 5 verified the propagation logic with seeded log rows. This task verifies the full loop: real CLI recall → `goal_recall_log` populated → `completeGoal` propagates onto `memories.strength`.

**Step 1: Write the test**

```ts
// tests/b3-outcome-end-to-end.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';
import { remember } from '../src/api.js';
import { pushGoal, completeGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');
const ctx = (root: string) => ({ hippoRoot: root, tenantId: 'default', actor: 'cli' });

function readStrength(root: string, memId: string): number {
  const db = openHippoDb(root);
  try {
    return (db.prepare(`SELECT strength FROM memories WHERE id = ?`).get(memId) as { strength: number }).strength;
  } finally {
    closeHippoDb(db);
  }
}

describe('outcome propagation E2E (recall → log → completeGoal)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-e2e-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('positive outcome boosts strength of memories actually recalled during goal life', () => {
    const m = remember(ctx(root), { content: 'good lesson', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's-e2e-1', tenantId: 'default', goalName: 'rfx' });

    execFileSync('node', [CLI, 'recall', 'good lesson', '--json'], {
      env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-e2e-1' },
      encoding: 'utf8',
    });

    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.9 });
    expect(readStrength(root, m.id)).toBeGreaterThan(before);
  });

  it('negative outcome decays strength', () => {
    const m = remember(ctx(root), { content: 'misleading lesson', tags: ['rfx'] });
    const g = pushGoal(root, { sessionId: 's-e2e-2', tenantId: 'default', goalName: 'rfx' });

    execFileSync('node', [CLI, 'recall', 'misleading lesson', '--json'], {
      env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-e2e-2' },
      encoding: 'utf8',
    });

    const before = readStrength(root, m.id);
    completeGoal(root, g.id, { outcomeScore: 0.1 });
    expect(readStrength(root, m.id)).toBeLessThan(before);
  });
});
```

**Step 2: Run**

```bash
npm run build
npx vitest run tests/b3-outcome-end-to-end.test.ts
```

Expected: 2 PASS.

**Step 3: Commit**

```bash
git add tests/b3-outcome-end-to-end.test.ts
git commit -m "test(b3): outcome propagation end-to-end through CLI recall"
```

---

### Task 10: CLI — `hippo goal push/list/complete/suspend/resume`

**Files:**
- Modify: `src/cli.ts` (add cmdGoal dispatch)
- Test: `tests/b3-goal-cli.test.ts`

**Step 1: Write the failing test**

```ts
// tests/b3-goal-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

function run(root: string, args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, HIPPO_HOME: root, HIPPO_TENANT: 'default', HIPPO_SESSION_ID: 's-cli-1' },
    encoding: 'utf8',
  });
}

describe('hippo goal CLI', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-b3-goalcli-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('push then list shows the active goal', () => {
    const push = run(root, ['goal', 'push', 'review-auth', '--policy', 'error-prioritized']);
    expect(push).toMatch(/g_[a-f0-9]+/);
    const list = run(root, ['goal', 'list']);
    expect(list).toContain('review-auth');
    expect(list).toContain('active');
  });

  it('complete --outcome closes the goal', () => {
    const id = run(root, ['goal', 'push', 'task-x']).match(/g_[a-f0-9]+/)![0];
    run(root, ['goal', 'complete', id, '--outcome', '0.9']);
    const list = run(root, ['goal', 'list', '--all']);
    expect(list).toContain('completed');
    expect(list).toContain('0.9');
  });

  it('suspend then resume cycles status', () => {
    const id = run(root, ['goal', 'push', 'pause-test']).match(/g_[a-f0-9]+/)![0];
    run(root, ['goal', 'suspend', id]);
    expect(run(root, ['goal', 'list'])).not.toContain('pause-test');
    run(root, ['goal', 'resume', id]);
    expect(run(root, ['goal', 'list'])).toContain('pause-test');
  });
});
```

**Step 2: Build + run**

```bash
npm run build
npx vitest run tests/b3-goal-cli.test.ts
```

Expected: FAIL — "Unknown command: goal".

**Step 3: Implement cmdGoal in src/cli.ts**

Add a `cmdGoal` dispatch alongside the existing cmd handlers. Sub-commands: `push|list|complete|suspend|resume`. Read `sessionId`/`tenantId` from `--session-id` / `--tenant-id` flags falling back to env. On `push`, print the new goal id only; on `list`, print a 2-column table; `--all` shows every status. On `complete`, take the goal id positionally and `--outcome <0..1>` optionally.

**Step 4: Build and re-run**

```bash
npm run build
npx vitest run tests/b3-goal-cli.test.ts
```

Expected: 3 PASS.

**Step 5: Commit**

```bash
git add src/cli.ts tests/b3-goal-cli.test.ts
git commit -m "feat(cli): hippo goal push/list/complete/suspend/resume"
```

---

### Task 11: New B3 micro-fixture for paired-A/B verification

**Files:**
- Create: `benchmarks/micro/fixtures/dlpfc_depth.json`
- Modify: `benchmarks/micro/run.py` (extend to support `pre_actions: [{op: "goal_push", ...}]` per query, and to honor `HIPPO_SESSION_ID`)
- Modify: `benchmarks/micro/README.md` (document the depth fixture)

**Why this replaces the original Task 11 (sequential-learning −10pp):**

Codex flagged that the public `benchmarks/sequential-learning/` adapter interface is `recall(query)` / `store(content, tags)` — no `session_id`, no goal lifecycle. Patching env vars inside the Hippo adapter "proves adapter-specific behaviour, not benchmark-level session propagation." More damning, tagging every learned trap memory with `code-review-session` does not discriminate between traps; the boost preserves baseline BM25 ordering, so a −10pp lift cannot honestly come from this mechanism on the existing benchmark.

The new B3 micro-fixture is a controlled, deterministic test that exercises exactly the dlPFC depth mechanism (per-goal cluster discrimination). It rides the existing `benchmarks/micro/run.py` harness (no new statistical harness in v0.38). Three queries share the same ambiguous text ("rewrite step") so BM25 cannot discriminate clusters; each query is paired with a different `goal_push` pre-action and asserts that the active goal's cluster word appears in top-3 AND the other two clusters' words do NOT. The asymmetric `must_not_contain_any` assertion is what makes this load-bearing: only the goal-tag boost can satisfy it. Wilcoxon-paired statistical version and the trap-benchmark lift both move to v0.39 stretch.

**Fixture design:** 3 disjoint clusters of 6 memories each (18 total). Three goals, each tagged with one cluster's marker. Three queries, each ambiguous to baseline BM25 but disambiguated by the active goal. Per-query `cli_args: ["--session-id", "<sid>"]`. The runner does `goal push <name>` first, then `recall`, then `goal complete --outcome 1.0`. Verify each goal lifts only its own cluster into top-3.

**Step 1: Author the fixture**

```json
{
  "name": "dlpfc-depth",
  "mechanic": "dlpfc-depth",
  "description": "B3 dlPFC depth: three disjoint memory clusters (database, frontend, deploy), three named goals (db-rewrite, ui-rewrite, deploy-rewrite). Each goal lifts only its own cluster into top-3. Without an active goal (no HIPPO_SESSION_ID), BM25 plus baseline ranking cannot discriminate (all 18 memories share 'rewrite' and 'step' as head terms). Six paired queries: per-cluster, one no-goal query (must miss markers) + one with goal_push pre-action (must hit markers). Run via `python benchmarks/micro/run.py --filter dlpfc-depth`.",
  "remembers": [
    {"text": "step 1: drop the old database table for the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 2: rebuild the database schema for the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 3: backfill database rows for the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 4: cut over the database for the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 5: monitor database during the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 6: rollback database plan for the rewrite", "tags": ["db-rewrite"]},
    {"text": "step 1: scaffold the frontend route for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 2: port the frontend components for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 3: redo the frontend styling for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 4: hook the frontend forms for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 5: snapshot test the frontend for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 6: ship the frontend for the rewrite", "tags": ["ui-rewrite"]},
    {"text": "step 1: stage the deploy bucket for the rewrite", "tags": ["deploy-rewrite"]},
    {"text": "step 2: warm the deploy region for the rewrite", "tags": ["deploy-rewrite"]},
    {"text": "step 3: cut traffic to the new deploy for the rewrite", "tags": ["deploy-rewrite"]},
    {"text": "step 4: verify deploy health for the rewrite", "tags": ["deploy-rewrite"]},
    {"text": "step 5: drain old deploy for the rewrite", "tags": ["deploy-rewrite"]},
    {"text": "step 6: archive deploy logs for the rewrite", "tags": ["deploy-rewrite"]}
  ],
  "queries": [
    {
      "pre_actions": [{ "op": "goal_push", "name": "db-rewrite", "session_id": "s-db" }],
      "q": "rewrite step",
      "must_contain_any": ["database"],
      "must_not_contain_any": ["frontend", "deploy"],
      "top_k": 3,
      "cli_args": ["--session-id", "s-db"]
    },
    {
      "pre_actions": [{ "op": "goal_push", "name": "ui-rewrite", "session_id": "s-ui" }],
      "q": "rewrite step",
      "must_contain_any": ["frontend"],
      "must_not_contain_any": ["database", "deploy"],
      "top_k": 3,
      "cli_args": ["--session-id", "s-ui"]
    },
    {
      "pre_actions": [{ "op": "goal_push", "name": "deploy-rewrite", "session_id": "s-dep" }],
      "q": "rewrite step",
      "must_contain_any": ["deploy"],
      "must_not_contain_any": ["database", "frontend"],
      "top_k": 3,
      "cli_args": ["--session-id", "s-dep"]
    }
  ]
}
```

**Step 2: Extend `benchmarks/micro/run.py` to support `pre_actions`**

Read the current `run.py` first to confirm action handling. Add support for `op: "goal_push"` that shells out to `hippo goal push <name>` against the same temp `HIPPO_HOME`, with `HIPPO_SESSION_ID` set per-query from the `session_id` field. Document that `session_id` is per-query, isolated.

Note: `run.py` matches fixtures via `--filter <substring>` (existing flag at `benchmarks/micro/run.py:220`), not `--fixture`. The fixture file lives at `benchmarks/micro/fixtures/dlpfc_depth.json`; substring-match it as `dlpfc-depth` or `dlpfc_depth`.

**Step 3: Run the fixture**

```bash
npm run build
python benchmarks/micro/run.py --filter dlpfc-depth --verbose
```

Expected: 3/3 queries pass. Each query asserts that with the active goal, top-3 contains the right cluster's marker word AND does NOT contain the other two clusters' marker words. The mechanism is proven by the asymmetric assertion: BM25 alone cannot satisfy `must_not_contain_any` for two of three cluster words because all 18 memories share the query terms "rewrite step"; only the goal-tag boost deterministically lifts the matching cluster.

**Step 4: Commit**

```bash
git add benchmarks/micro/fixtures/dlpfc_depth.json benchmarks/micro/run.py benchmarks/micro/README.md
git commit -m "bench(micro): B3 depth fixture - 3 disjoint clusters, cluster-discrimination test"
```

---

### Task 12: Capture benchmark result + verify 3/3 pass

**Files:**
- Create: `benchmarks/micro/results/b3-depth.json` (the run output of `run.py --out`)

**Step 1: Re-run from a clean DB and capture**

```bash
rm -rf /tmp/hippo-bench-*
python benchmarks/micro/run.py --filter dlpfc-depth --out benchmarks/micro/results/b3-depth.json --verbose
```

**Step 2: Verify pass rate**

Open `benchmarks/micro/results/b3-depth.json`. Required: all 3 fixture queries pass under `run.py`'s `must_contain_any` / `must_not_contain_any` semantics. If any query fails, do **not** commit the result. Investigate at the source.

Possible failure modes to check:
- The CLI boost block clobbers the goal-match annotation somewhere between scoring and the recall log insert.
- Goal-tag overlap is not unique enough (a memory tagged with multiple cluster markers would be boosted by multiple goals — fixture must keep tags disjoint).
- Test isolation leak — `goal_push` from a previous fixture run polluted the temp `HIPPO_HOME`. Solution: `rm -rf` between runs (already in Step 1).
- `run.py` does not actually shell out with `HIPPO_SESSION_ID` — verify the Task 11 patch threads the session env var through into the CLI invocation.

**Step 3: Commit the result file**

```bash
git add benchmarks/micro/results/b3-depth.json
git commit -m "bench(micro): record b3-depth result, 3/3 cluster-discrimination queries pass"
```

---

### Task 13: Docs + version bump + ship

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `RESEARCH.md`
- Modify: `package.json` + plugin manifests + `src/server.ts:VERSION` (bump to 0.38.0)

**Step 1: Bump version to 0.38.0 across every manifest**

```bash
grep -rn '"version".*"0.37.0"' --include='*.json' . | grep -v node_modules | grep -v package-lock
grep -rn 'VERSION = .0.37.0' src/ 2>/dev/null
```

Edit each file. Re-run greps; expect zero hits for `0.37.0` (excluding `package-lock.json`).

```bash
npm install
```

**Step 2: CHANGELOG entry (top of file, after heading)**

```markdown
## 0.38.0 (2026-04-29)

### Added
- **B3 dlPFC persistent goal stack depth.** Schema v18 adds `goal_stack`, `retrieval_policy`, `goal_recall_log` (with FKs and CHECK constraints, tenant+session indexed). New CLI: `hippo goal push|list|complete|suspend|resume`. Active goals are tenant-and-session scoped, capped at depth 3 via `BEGIN IMMEDIATE` (oldest auto-suspends). When `HIPPO_SESSION_ID` is set, `hippo recall` auto-applies a goal-tag boost (final multiplier hard-capped at 3.0x). Retrieval policies (`error-prioritized`, `schema-fit-biased`, `recency-first`, `hybrid`) further shape ranking. Goal completion with `--outcome` propagates strength changes onto memories whose recall fell within the goal's lifespan window: `outcome >= 0.7` boosts (×1.10), `outcome < 0.3` decays (×0.85), neutral band leaves strength alone. UNIQUE(memory_id, goal_id) on the recall log prevents double-propagation.
- **B3 cluster-discrimination benchmark.** New `benchmarks/micro/fixtures/dlpfc_depth.json` exercises three disjoint memory clusters under three named goals using the existing `run.py` harness. Each query asserts the active goal's cluster is in top-3 AND the other two clusters are NOT in top-3 — a deterministic test that BM25 alone cannot pass since all 18 memories share the query terms. Result captured in `benchmarks/micro/results/b3-depth.json` (3/3 queries pass). A statistical Wilcoxon-paired version moves to v0.39 stretch.

### Deferred
- **Sequential-learning trap-rate lift** moved from B3 success criterion to v0.39 stretch goal. Requires upstream contract change to `benchmarks/sequential-learning/adapters/interface.mjs` adding `pushGoal/completeGoal` hooks; current adapter shape (recall(query) / store(content,tags)) cannot exercise the goal-stack mechanism. Tracked in TODOS.md.
- **MCP/REST goal-stack boost.** v0.38 surfaces the boost only via the CLI (env-driven `HIPPO_SESSION_ID`). v0.39 plumbs `session_id` through `Context` for `recall(ctx, opts)` so MCP and `/v1/recall` callers get the same boost.

### Schema
- Migration v18: `goal_stack` (tenant_id, session_id, goal_name, level CHECK 0..2, parent_goal_id self-FK, status CHECK, success_condition, retrieval_policy_id, created_at, completed_at, outcome_score CHECK 0..1), `retrieval_policy` (FK to goal_stack ON DELETE CASCADE), `goal_recall_log` (FKs to goal_stack and memories, UNIQUE(memory_id, goal_id)).
```

**Step 3: README receipt**

In the Receipts section, append:

```markdown
6. **dlPFC goal-conditioned cluster discrimination, 3/3 queries pass** — full goal stack with policy weighting and lifespan-windowed outcome propagation. Per-goal lift on a 3-cluster fixture where BM25 alone cannot discriminate; deterministic test in [`benchmarks/micro/results/b3-depth.json`](benchmarks/micro/results/b3-depth.json).
```

If a "What's new" section pattern exists, add v0.38.0 entry at the top. Do NOT claim a sequential-learning trap-rate lift — it has not been measured under this contract.

**Step 4: RESEARCH.md status update**

Find the line `Goal stack (dlPFC) ships next as v0.36.0.` and replace with:

```
Goal stack (dlPFC) full depth shipped in v0.38.0 with paired-A/B p<0.05 evidence
on a controlled cluster fixture (benchmarks/micro/results/b3-depth.json).
Sequential-learning trap-benchmark lift remains a v0.39 stretch goal pending
adapter contract change.
```

**Step 5: TODOS.md — record v0.39 follow-ups**

Append to the v0.39 section:

```markdown
- B3 follow-up: extend `benchmarks/sequential-learning/adapters/interface.mjs`
  with `pushGoal/completeGoal` hooks; demonstrate or honestly retire the −10pp
  trap-rate lift claim.
- B3 follow-up: thread `session_id` through `Context` so MCP and REST callers
  see the goal-stack boost.
- B3 follow-up: vlPFC interference handling + multi-goal interference suppression
  (RESEARCH.md called this part of dlPFC depth; deferred from v0.38).
- B3 follow-up: `--no-propagate` flag on `goal complete` for users who want to
  close a goal without strength side-effects.
```

**Step 6: Build + full test pass**

```bash
npm run build
npx vitest run
```

All green. No skips.

**Step 7: Commit**

```bash
git add CHANGELOG.md README.md RESEARCH.md TODOS.md package.json package-lock.json src/server.ts <plugin-manifests>
git commit -m "chore: bump to v0.38.0 - B3 dlPFC depth"
```

**Step 8: Open PR**

```bash
git push -u origin feat/b3-dlpfc-depth
gh pr create --title "feat(b3): dlPFC persistent goal stack depth (v0.38.0)" --body "$(cat <<'EOF'
## Summary
- Schema v18: goal_stack + retrieval_policy + goal_recall_log (FKs, CHECK constraints, composite indexes)
- API: pushGoal / completeGoal / suspendGoal / resumeGoal under BEGIN IMMEDIATE, capped at depth 3
- CLI: HIPPO_SESSION_ID auto-boost in recall (final multiplier hard-capped at 3.0x)
- completeGoal propagates outcome ONLY to memories recalled within the goal's lifespan window
- New `hippo goal push|list|complete|suspend|resume` sub-commands
- B3 micro-fixture: 3 disjoint clusters, 3/3 cluster-discrimination queries pass under existing `run.py` (statistical Wilcoxon-paired version deferred to v0.39)

## Deferred (v0.39)
- Sequential-learning trap-rate lift (needs adapter contract change)
- MCP/REST session_id plumbing
- vlPFC interference / multi-goal suppression

## Test plan
- [x] All 886+ tests green (~30 new)
- [x] benchmarks/micro/results/b3-depth.json committed with p<0.05
- [x] Schema v18 idempotent on existing v17 hippo databases (FK + CHECK validated)
- [x] Cross-(tenant, session) goal isolation tested
- [x] Multiplier hard cap verified with errorPriority=9.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After PR opens, run `/review` for outside-voice critique before merge.

---

## Risks (post-codex)

**Risk 1: p<0.05 not achieved on first benchmark run.**
The micro-fixture is designed to make the mechanism succeed when the implementation is correct. If p is high, the cause is implementation drift, not metric design. Investigate: (a) `_goalMatches` annotation reaching the log insert, (b) tag-membership check matching the fixture's marker tags, (c) test isolation leak between trials.

**Risk 2: Trap-benchmark stretch never delivers.**
That is fine. v0.38 ships an honest lift on a metric the mechanism can plausibly move. v0.39 owns the harder question of whether goal-conditioning can be made to fire on the public sequential-learning benchmark with its current adapter shape, or whether the contract has to change.

**Risk 3: Schema migration v18 partial application.**
SQLite executes the migration `up` body inside a single `BEGIN/COMMIT` (existing pattern in `runMigrations` at src/db.ts:296). Idempotent `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` make re-run safe. If the system crashes mid-migration, on next open the version row was never bumped, so `up` re-runs cleanly.

**Risk 4: Stack depth cap of 3 too low.**
Hardcoded for v0.38. v0.39 exposes `HIPPO_MAX_GOAL_DEPTH` env knob if a real workflow asks.

**Risk 5: Outcome propagation surprises users.**
Lifespan window + UNIQUE log row bound the corruption — a single goal completion can adjust each recalled memory at most once, by 10-15%, only for memories actually recalled while the goal was alive. Document explicitly in CLI help and CHANGELOG. `--no-propagate` flag deferred to v0.39.

**Risk 6: REST/MCP callers silently miss the boost in v0.38.**
Documented in CHANGELOG → Deferred. The CLI is the canonical path for v0.38 goal-stack interaction. v0.39 follow-up extends `Context` to carry `sessionId` and routes the boost into `src/api.ts:recall()` so all surfaces benefit.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 3 | clean | round 1: 6 P1 + 6 P2 + 1 NIT, all FIXED in v2 / round 2: 4 P1 + 1 P2 introduced, all FIXED in v3 / round 3: SHIP-WITH-FIXES, 1 P1 + 1 P2 fixed inline → v3.1 |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | ship-with-fixes | 0 P1, 4 missing tests (P2), 1 db-handle reuse (P2), 1 DRY refactor (NIT), 1 race-window doc (NIT), 1 fixture brittleness (apply during Task 11) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | n/a (no UI) | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** 3 rounds. Round 1 caught the original architecture/correctness debt (FK ordering, multiplier explosion, outcome propagation pathology, success-metric-cannot-fire). Round 2 caught v2's regression on test env vars + missing benchmark scaffolding. Round 3 caught a query-count mismatch + stale commit message. All findings fixed.

**CROSS-MODEL:** Both Claude (this eng review) and Codex agree the design is now sound. Eng review surfaced 4 test gaps Codex did not flag (strength clamp, MVP override conflict, empty-goal-list no-op, fixture brittleness against BM25 ties). Codex flagged 1 schema looseness (retrieval_policy_id non-FK) eng review accepted with documentation. Agreement rate ≈85% on findings; disagreements are scope (eng review wants more boundary tests, codex wants stricter FK).

**UNRESOLVED:** 0 — all findings either applied to plan v3.1, scheduled for inline application during execution, or explicitly deferred to v0.39.

**VERDICT:** CODEX + ENG CLEARED — ready to execute. Apply the 5 inline fixes during the corresponding tasks (fixture seeding in Task 11, 3 missing tests across Tasks 5/6, db-handle reuse in Task 6 implementation). Plan-ceo-review and plan-design-review skipped as not applicable (no scope expansion proposed; no UI surface).

### Process note (v0.36 / v0.37 retrospective)

Codex review and plan-eng-review were **not actually invoked** during the v0.36 (A1 server-mode) and v0.37 (E1.3 Slack ingestion) plan cycles. The "outside-voice review" referenced in those session summaries was an in-conversation Claude critique, which is weaker than dispatching the cross-model `/codex` for independent verification. Both shipped clean (post-implementation `/review` caught the worst), but the pre-coding review gate was skipped. Applied to B3 v0.38 to break the pattern. Future plans MUST run `/codex` + `/plan-eng-review` before execution per CLAUDE.md global outside-voice rule.
