# Sequence Binding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let hippo store `A → B → C → outcome` as a bound trace — a single queryable memory capturing an ordered sequence of actions and its final outcome — so recursive-self-improvement agents can learn from past strategies instead of re-deriving them from scratch every run.

**Architecture:** Add a new `Layer.Trace` to the existing memory schema. A trace is a first-class `MemoryEntry` with `layer='trace'`, a new `trace_outcome` column (`'success' | 'failure' | 'partial' | null`), and its `parents` field linking back to the source `session_events`. This reuses the whole existing retrieval / decay / embedding / physics stack — traces inherit recall, outcome feedback, conflict detection, and the 569-test safety net. Two new CLI commands: `hippo trace record` (explicit) and `hippo sleep` auto-promotion (implicit) from session events.

**Tech Stack:** TypeScript, Node 22.5+, vitest, SQLite (`node:sqlite`), existing `MemoryEntry` schema + `INDEX_VERSION` migration pattern.

---

## Plan Review Revisions (2026-04-21)

Applied after `/plan-eng-review` flagged three load-bearing design blockers plus scope tweaks.

**Blockers fixed:**

1. **Idempotency is now explicit.** Schema adds a `source_session_id` column (nullable, indexed). Auto-promotion guards against duplicate traces via `WHERE source_session_id = ? AND layer = 'trace'`, not tag magic.
2. **Outcome-event contract is now explicit.** New CLI command `hippo session complete --session <id> --outcome <success|failure|partial>` writes the terminal event. Auto-promotion fires only for sessions with a matching `session_complete` event. Without this command, Phase C would silently never trigger in production.
3. **`trace_steps_json` column removed.** YAGNI. Markdown `content` is the v1 source of truth. If programmatic step access is needed in v2, ship the column then.

**Other tweaks:**

- `detectConflicts` now skips when both entries have `layer === 'trace'` — traces are variants, not contradictions.
- Auto-promotion scans only sessions newer than `config.autoTraceWindowDays` (default 7).
- Auto-promoted traces use `parents: []`. Provenance lives in the new `source_session_id` column, not synthetic `session-event-${id}` strings polluting the `parents` field.
- Phase C task renumbered: C1 = schema + guard helpers, C2 = auto-promote pass, C3 = inheritance smoke tests (decay / embeddings / replay / no-conflict).
- Phase D RSI demo now has a pass bar: `lateRate - earlyRate >= 0.20` or the demo fails CI.
- Added T-crit: v2→v3 migration with existing data test.

All task numbering below reflects these revisions.

---

## Why this is the right shape

- **Reuses existing machinery.** Decay, retrieval-strengthening, conflict detection, embeddings, and the physics engine ALL work on `MemoryEntry`. A trace IS a memory; everything else is free.
- **Foundation for counterfactuals and skill-tier.** Once traces exist, a counterfactual is a trace with `outcome='failure'` linked to a successful sibling. A skill is a trace promoted to a reusable procedure. Sequence binding is the primitive; the other two are compositions.
- **Direct RSI benefit.** An agent can query `hippo recall "<new task>" --outcome success` and get ranked prior successful strategies. That's the Voyager skill library in miniature.
- **Honest scope.** Shippable in 1-2 weeks as a single feature, not a 6-month platform rewrite.

## File inventory

**New files:**
- `src/trace.ts` — trace-specific helpers: markdown rendering of steps, outcome ranking, auto-promotion from session events.
- `tests/trace.test.ts` — unit tests for `trace.ts` helpers.
- `tests/trace-integration.test.ts` — end-to-end: record → recall → outcome feedback.
- `examples/rsi-demo/` — minimal self-improving agent demo that uses traces.

**Modified files:**
- `src/memory.ts` — add `Trace` to `Layer` enum, add optional `trace_outcome` and `trace_steps_json` fields to `MemoryEntry`.
- `src/store.ts` — schema migration (bump `INDEX_VERSION` 2 → 3), add columns, update row mapping, update `MEMORY_SELECT_COLUMNS`.
- `src/cli.ts` — new `hippo trace record` command, `--outcome` + `--layer` filters on `hippo recall`, help text.
- `src/consolidate.ts` — auto-promote step in the sleep pipeline (guarded by config flag).
- `src/config.ts` — new `autoTraceCapture: boolean` config field (default true).
- `CHANGELOG.md`, `README.md` — release notes + a short "recursive self-improvement" section.

## Non-goals (explicit)

- **Counterfactual memory** — deferred. Needs traces as foundation. Separate plan.
- **Skill-tier (executable procedures)** — deferred. Separate plan.
- **Multi-session trace chains** ("trace T2 built on trace T1") — v2 extension. For v1 each trace is self-contained.
- **Structured programmatic access to step data** — v1 stores steps as markdown in `content`. Structured JSON access (`trace_steps_json`) is scaffolded in the schema but not exposed via API.
- **UI / dashboard visualisation of traces** — out of scope.
- **Physics integration (traces as particles)** — inherits for free from the `MemoryEntry` base but no trace-specific tuning in v1.

## Risks

| Risk | Mitigation |
|---|---|
| Schema migration on existing user databases fails | Pattern already proven in `INDEX_VERSION 1 → 2`. New columns are nullable → existing rows untouched. Include regression test with a pre-migration snapshot. |
| Auto-promotion during `hippo sleep` fires incorrectly and clutters the store | Require `--outcome` to be explicitly set on the session before promotion kicks in. No outcome = no trace. Also: `config.autoTraceCapture: false` kill-switch. |
| Trace markdown renders ugly in context blocks | Test the rendering; cap step count displayed; use a consistent format agents can parse. |
| Retrieval-strengthening inflates `retrieval_count` on traces every recall | Existing `markRetrieved` is fine for traces. Traces are meant to be strengthened on use — that's the whole RSI point. No change needed. |
| Search ranking drowns traces vs. plain memories (or vice versa) | Use `--layer trace` filter for explicit queries. Default `hippo recall` returns mixed, ranked by score. Track per-layer recall rate in eval. |

---

## Phase A — Schema + data model

### Task A1: Extend Layer enum

**Files:**
- Modify: `src/memory.ts:8-12` (Layer enum)
- Modify: `tests/memory.test.ts` (add enum assertion)

**Step 1: Write failing test**

Append to `tests/memory.test.ts`:

```ts
import { Layer } from '../src/memory.js';

describe('Layer.Trace', () => {
  it('is a distinct layer from buffer/episodic/semantic', () => {
    expect(Layer.Trace).toBe('trace');
    expect(Layer.Trace).not.toBe(Layer.Buffer);
    expect(Layer.Trace).not.toBe(Layer.Episodic);
    expect(Layer.Trace).not.toBe(Layer.Semantic);
  });
});
```

**Step 2: Run test, verify fail**

```bash
npx vitest run tests/memory.test.ts
```

Expected: fail — `Layer.Trace is not exported`.

**Step 3: Implement**

In `src/memory.ts`:

```ts
export enum Layer {
  Buffer = 'buffer',
  Episodic = 'episodic',
  Semantic = 'semantic',
  Trace = 'trace',  // NEW: ordered action→outcome sequence for RSI
}
```

**Step 4: Verify pass**

```bash
npx vitest run tests/memory.test.ts
```

**Step 5: Commit**

```bash
git add src/memory.ts tests/memory.test.ts
git commit -m "feat(memory): add Layer.Trace enum value"
```

### Task A2: Add `trace_outcome` and `source_session_id` to MemoryEntry

**Files:**
- Modify: `src/memory.ts` (MemoryEntry interface + createMemory defaults)
- Modify: `tests/memory.test.ts`

**Step 1: Write failing test**

```ts
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';

describe('MemoryEntry trace fields', () => {
  it('defaults trace_outcome and source_session_id to null for non-trace entries', () => {
    const m = createMemory('plain memory content', { layer: Layer.Episodic });
    expect(m.trace_outcome).toBeNull();
    expect(m.source_session_id).toBeNull();
  });

  it('accepts trace_outcome when explicitly provided', () => {
    const m = createMemory('a trace', {
      layer: Layer.Trace,
      trace_outcome: 'success',
    });
    expect(m.trace_outcome).toBe('success');
  });

  it('accepts source_session_id on auto-promoted traces', () => {
    const m = createMemory('a trace', {
      layer: Layer.Trace,
      trace_outcome: 'success',
      source_session_id: 'sess-abc-123',
    });
    expect(m.source_session_id).toBe('sess-abc-123');
  });

  it('rejects invalid trace_outcome values', () => {
    expect(() => createMemory('invalid', {
      layer: Layer.Trace,
      trace_outcome: 'not-a-real-outcome' as any,
    })).toThrow(/trace_outcome/);
  });
});
```

**Step 3: Implement**

```ts
export type TraceOutcome = 'success' | 'failure' | 'partial' | null;

export interface MemoryEntry {
  // ... existing fields
  trace_outcome: TraceOutcome;
  source_session_id: string | null;  // set by auto-promote; null for everything else
}

// In createMemory:
const validOutcomes: (string | null)[] = ['success', 'failure', 'partial', null];
if (opts.trace_outcome !== undefined && !validOutcomes.includes(opts.trace_outcome)) {
  throw new Error(`Invalid trace_outcome: ${opts.trace_outcome}. Must be 'success', 'failure', 'partial', or null.`);
}
return {
  // ... existing fields
  trace_outcome: opts.trace_outcome ?? null,
  source_session_id: opts.source_session_id ?? null,
};
```

**Step 4: Pass + Step 5: Commit**

```bash
git add src/memory.ts tests/memory.test.ts
git commit -m "feat(memory): add trace_outcome + source_session_id fields"
```

**Note:** `trace_steps_json` was removed from the v1 design per plan review. Markdown `content` is the v1 source of truth; structured step access is deferred to v2 when a concrete reader exists.

### Task A3: Schema migration — add columns to SQLite

**Files:**
- Modify: `src/store.ts` (INDEX_VERSION, CREATE TABLE, migration path, rowToEntry, MEMORY_SELECT_COLUMNS, writeEntry SQL)
- Test: `tests/store-migration.test.ts` (NEW)

**Step 1: Migration tests (fresh + existing-data)**

```ts
// tests/store-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { DatabaseSync } from 'node:sqlite';

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sch-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('schema v3: trace columns', () => {
  it('round-trips trace_outcome + source_session_id on a fresh store', () => {
    initStore(tmpDir);
    const t = createMemory('traced experience content', {
      layer: Layer.Trace,
      trace_outcome: 'success',
      source_session_id: 'sess-1',
    });
    writeEntry(tmpDir, t);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === t.id);
    expect(loaded).toBeDefined();
    expect(loaded!.trace_outcome).toBe('success');
    expect(loaded!.source_session_id).toBe('sess-1');
    expect(loaded!.layer).toBe(Layer.Trace);
  });

  it('non-trace memories round-trip with trace fields null', () => {
    initStore(tmpDir);
    const m = createMemory('plain episodic memory content', { layer: Layer.Episodic });
    writeEntry(tmpDir, m);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === m.id);
    expect(loaded!.trace_outcome).toBeNull();
    expect(loaded!.source_session_id).toBeNull();
  });

  // T-crit: the v2 → v3 migration on existing data.
  it('migrates a v2 store with existing memories without data loss', () => {
    // Manually construct a v2-shaped store (no trace columns), insert a row,
    // then call initStore which should add the columns and preserve the row.
    const dbPath = path.join(tmpDir, 'hippo.db');
    const db = new DatabaseSync(dbPath);
    // v2 minimal schema — mirror the production v2 CREATE TABLE exactly.
    db.exec(`
      CREATE TABLE schema_meta (version INTEGER);
      INSERT INTO schema_meta VALUES (2);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        created TEXT, last_retrieved TEXT, retrieval_count INTEGER,
        strength REAL, half_life_days REAL, layer TEXT,
        tags_json TEXT, emotional_valence TEXT, schema_fit REAL,
        source TEXT, outcome_score REAL, outcome_positive INTEGER,
        outcome_negative INTEGER, conflicts_with_json TEXT,
        pinned INTEGER, confidence TEXT, content TEXT,
        parents_json TEXT, starred INTEGER
      );
      INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength,
        half_life_days, layer, tags_json, emotional_valence, schema_fit, source,
        outcome_score, outcome_positive, outcome_negative, conflicts_with_json,
        pinned, confidence, content, parents_json, starred)
      VALUES ('mem_legacy_v2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0,
        1.0, 7.0, 'episodic', '[]', 'neutral', 0.0, 'test', NULL, 0, 0, '[]',
        0, 'verified', 'pre-migration content body long enough to pass checks', '[]', 0);
    `);
    db.close();

    // Now initStore should migrate to v3.
    initStore(tmpDir);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === 'mem_legacy_v2');
    expect(loaded).toBeDefined();
    expect(loaded!.content).toContain('pre-migration content body');
    expect(loaded!.trace_outcome).toBeNull();
    expect(loaded!.source_session_id).toBeNull();
  });
});
```

**Step 2: Fail — columns don't exist**

**Step 3: Implement migration**

In `src/store.ts`:

1. Bump `INDEX_VERSION` 2 → 3.
2. Add to the CREATE TABLE statement for `memories`:

```sql
trace_outcome TEXT,
source_session_id TEXT,
```

3. Add migration logic:

```ts
const currentVersion = db.prepare(`SELECT version FROM schema_meta LIMIT 1`).get() as { version: number } | undefined;
if (!currentVersion || currentVersion.version < 3) {
  db.exec(`
    ALTER TABLE memories ADD COLUMN trace_outcome TEXT;
    ALTER TABLE memories ADD COLUMN source_session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_memories_source_session_id
      ON memories(source_session_id) WHERE source_session_id IS NOT NULL;
  `);
  db.prepare(`UPDATE schema_meta SET version = 3`).run();
}
```

4. Add both columns to `MEMORY_SELECT_COLUMNS`.
5. Update `rowToEntry` to populate the new fields from row.
6. Update `writeEntry` INSERT/UPDATE SQL to include them.

**Step 4: Pass. Step 5: Commit.**

```bash
git add src/store.ts tests/store-migration.test.ts
git commit -m "feat(store): schema v3 with trace_outcome + source_session_id (indexed)"
```

---

## Phase B — Record + recall API + session-complete

### Task B0: `hippo session complete` command

**Why:** Auto-promotion (Phase C) only triggers on a session that has a terminal outcome event. Without this command, agents have no supported way to emit one. This is the load-bearing contract for Phase C.

**Files:**
- Modify: `src/cli.ts` (new `session complete` subcommand under the existing `session` group)
- Test: `tests/trace.test.ts`

**Step 1: Test**

```ts
it('hippo session complete writes a session_complete event with outcome', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-complete-'));
  const hippoDir = path.join(tmp, '.hippo');
  try {
    initStore(hippoDir);
    execFileSync(process.execPath, [HIPPO_JS, 'session', 'complete',
      '--session', 'sess-x',
      '--outcome', 'success',
      '--summary', 'refactored auth module',
    ], { cwd: tmp, env: { ...process.env, HIPPO_HOME: path.join(tmp, 'global') } });

    // listSessionEvents should show a session_complete event.
    const { listSessionEvents } = await import('../src/store.js');
    const events = listSessionEvents(hippoDir, { session_id: 'sess-x' });
    const complete = events.find((e) => e.event_type === 'session_complete');
    expect(complete).toBeDefined();
    expect(complete!.content).toBe('success');
    expect(complete!.metadata.summary).toBe('refactored auth module');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

it('rejects invalid outcomes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-complete-bad-'));
  try {
    initStore(path.join(tmp, '.hippo'));
    expect(() => execFileSync(process.execPath, [HIPPO_JS, 'session', 'complete',
      '--session', 'sess-x', '--outcome', 'not-real',
    ], { cwd: tmp, env: { ...process.env, HIPPO_HOME: path.join(tmp, 'global') } }))
      .toThrow();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Implement**

New subcommand. Validates outcome in `['success', 'failure', 'partial']`. Calls `appendSessionEvent` with `event_type: 'session_complete'`, `content: outcome`, `metadata: { summary, ended_at: now }`. Prints the event ID.

**Step 3: Pass + commit**

```bash
git add src/cli.ts tests/trace.test.ts
git commit -m "feat(cli): hippo session complete — emit terminal outcome event"
```

---

## Phase B — Record + recall API

### Task B1: `hippo trace record` command

**Files:**
- Modify: `src/cli.ts` (new command handler)
- Create: `src/trace.ts` (helpers)
- Create: `tests/trace.test.ts`

**Step 1: Failing test**

```ts
// tests/trace.test.ts
import { describe, it, expect } from 'vitest';
import { renderTraceContent, parseSteps } from '../src/trace.js';

describe('renderTraceContent', () => {
  it('renders a successful trace as markdown', () => {
    const md = renderTraceContent({
      task: 'fix failing test',
      steps: [
        { action: 'read test file', observation: 'assertion error' },
        { action: 'edit src/foo.ts:42', observation: 'test passes' },
      ],
      outcome: 'success',
    });
    expect(md).toContain('Task: fix failing test');
    expect(md).toContain('Outcome: success');
    expect(md).toContain('1. read test file');
    expect(md).toContain('→ assertion error');
    expect(md).toContain('2. edit src/foo.ts:42');
  });
});

describe('parseSteps', () => {
  it('parses a JSON steps string', () => {
    const s = parseSteps('[{"action":"a","observation":"b"}]');
    expect(s).toHaveLength(1);
    expect(s[0].action).toBe('a');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSteps('not-json')).toThrow(/trace steps/);
  });
});
```

**Step 2: Fail.**

**Step 3: Implement**

```ts
// src/trace.ts
export interface TraceStep {
  action: string;
  observation: string;
  timestamp?: string;
}

export interface TraceRecord {
  task: string;
  steps: TraceStep[];
  outcome: 'success' | 'failure' | 'partial';
}

export function renderTraceContent(rec: TraceRecord): string {
  const lines: string[] = [];
  lines.push(`Task: ${rec.task}`);
  lines.push(`Outcome: ${rec.outcome}`);
  lines.push('Steps:');
  rec.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.action}`);
    if (s.observation) lines.push(`     → ${s.observation}`);
  });
  return lines.join('\n');
}

export function parseSteps(json: string): TraceStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid trace steps JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) throw new Error('trace steps must be an array');
  return parsed.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`trace step ${i}: not an object`);
    const rec = s as Record<string, unknown>;
    if (typeof rec.action !== 'string') throw new Error(`trace step ${i}: missing action`);
    return {
      action: rec.action,
      observation: typeof rec.observation === 'string' ? rec.observation : '',
      timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : undefined,
    };
  });
}
```

**Step 4: Pass. Step 5: Commit.**

```bash
git add src/trace.ts tests/trace.test.ts
git commit -m "feat(trace): markdown rendering + step parsing helpers"
```

### Task B2: Wire `hippo trace record` into CLI

**Files:**
- Modify: `src/cli.ts` (add `trace` command, route `trace record` subcommand)
- Extend: `tests/trace.test.ts` (integration test via subprocess)

**Step 1: Integration test**

```ts
// Append to tests/trace.test.ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initStore, loadAllEntries } from '../src/store.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

describe('hippo trace record', () => {
  it('creates a Trace-layer memory with outcome + steps', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-trace-'));
    const hippoDir = path.join(tmp, '.hippo');
    try {
      initStore(hippoDir);

      execFileSync(process.execPath, [
        HIPPO_JS, 'trace', 'record',
        '--task', 'fix failing test suite',
        '--steps', JSON.stringify([
          { action: 'read test', observation: 'saw assertion error' },
          { action: 'edit src/foo.ts', observation: 'test passed' },
        ]),
        '--outcome', 'success',
      ], { cwd: tmp, env: { ...process.env, HIPPO_HOME: path.join(tmp, 'global') }, encoding: 'utf8' });

      const entries = loadAllEntries(hippoDir);
      const traces = entries.filter((e) => e.layer === 'trace');
      expect(traces).toHaveLength(1);
      expect(traces[0].trace_outcome).toBe('success');
      expect(traces[0].content).toContain('fix failing test suite');
      expect(traces[0].content).toContain('assertion error');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

**Step 2: Fail** — `trace` is not a valid command.

**Step 3: Implement in `src/cli.ts`**

Add a new dispatcher branch for `trace`, handling `record` subcommand. Parse `--task`, `--steps`, `--outcome`. Call `renderTraceContent`, pass to `createMemory` with `layer: Layer.Trace`, `trace_outcome`, `trace_steps_json: JSON.stringify(steps)`. Write via `writeEntry`. Print the new memory ID.

**Step 4: Pass. Step 5: Commit.**

```bash
git add src/cli.ts tests/trace.test.ts
git commit -m "feat(cli): hippo trace record command"
```

### Task B3: `--outcome` filter on `hippo recall`

**Files:**
- Modify: `src/cli.ts` (`cmdRecall` filter logic)
- Modify: `src/search.ts` (if needed — filter pre-ranking)
- Extend: `tests/trace.test.ts`

**Step 1: Test**

```ts
it('hippo recall --outcome success returns only successful traces', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-recall-'));
  const hippoDir = path.join(tmp, '.hippo');
  try {
    initStore(hippoDir);
    // Record one success + one failure trace with similar content
    for (const outcome of ['success', 'failure'] as const) {
      execFileSync(process.execPath, [
        HIPPO_JS, 'trace', 'record',
        '--task', `refactor auth module (${outcome})`,
        '--steps', '[{"action":"edit","observation":"done"}]',
        '--outcome', outcome,
      ], { cwd: tmp, env: { ...process.env, HIPPO_HOME: path.join(tmp, 'global') } });
    }

    const out = execFileSync(process.execPath, [
      HIPPO_JS, 'recall', 'refactor auth',
      '--outcome', 'success',
      '--json',
    ], { cwd: tmp, env: { ...process.env, HIPPO_HOME: path.join(tmp, 'global') }, encoding: 'utf8' });

    const parsed = JSON.parse(out);
    // Every returned result must have trace_outcome === 'success'
    for (const r of parsed.results ?? []) {
      if (r.layer === 'trace') expect(r.trace_outcome).toBe('success');
    }
    // And we must NOT see the failure trace
    const allText = JSON.stringify(parsed);
    expect(allText).toContain('refactor auth module (success)');
    expect(allText).not.toContain('refactor auth module (failure)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

**Step 2: Fail** — flag not recognised, returns both.

**Step 3: Implement in `cmdRecall`**

Parse `--outcome` flag. After initial ranking, filter results where `r.entry.layer === 'trace' && r.entry.trace_outcome !== targetOutcome`. Non-trace entries pass through unaffected (filter only applies to traces).

**Step 4: Pass. Step 5: Commit.**

```bash
git add src/cli.ts tests/trace.test.ts
git commit -m "feat(recall): --outcome filter for trace memories"
```

---

## Phase C — Auto-promotion from session events

### Task C1: Auto-promote on sleep (idempotent, bounded, parents-clean)

**Files:**
- Modify: `src/consolidate.ts` (new pass between decay and replay)
- Modify: `src/config.ts` (`autoTraceCapture: boolean`, `autoTraceWindowDays: number`)
- Create: `tests/trace-autopromote.test.ts`

**Step 1: Tests (including idempotency)**

```ts
it('consolidate promotes a session with session_complete event into a trace', () => {
  initStore(tmpDir);
  const sid = 'test-session-auto';
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'action', content: 'read x.ts', source: 'agent' });
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'action', content: 'edit line 42', source: 'agent' });
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'session_complete', content: 'success', source: 'agent' });

  consolidate(tmpDir, { now: new Date() });

  const traces = loadAllEntries(tmpDir).filter((e) => e.layer === 'trace');
  expect(traces).toHaveLength(1);
  expect(traces[0].trace_outcome).toBe('success');
  expect(traces[0].source_session_id).toBe(sid);
  expect(traces[0].parents).toEqual([]);  // NOT polluted with synthetic IDs
  expect(traces[0].content).toContain('read x.ts');
});

it('consolidate does NOT promote sessions with no session_complete event', () => {
  initStore(tmpDir);
  const sid = 'test-no-outcome';
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'action', content: 'did stuff', source: 'agent' });
  consolidate(tmpDir, { now: new Date() });
  expect(loadAllEntries(tmpDir).filter((e) => e.layer === 'trace')).toHaveLength(0);
});

// T-crit: idempotency across multiple sleep cycles.
it('consolidate does NOT create duplicate traces on repeated sleep runs', () => {
  initStore(tmpDir);
  const sid = 'test-idempotent';
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'action', content: 'action a', source: 'agent' });
  appendSessionEvent(tmpDir, { session_id: sid, event_type: 'session_complete', content: 'success', source: 'agent' });

  consolidate(tmpDir, { now: new Date() });
  consolidate(tmpDir, { now: new Date() });
  consolidate(tmpDir, { now: new Date() });

  const traces = loadAllEntries(tmpDir).filter((e) => e.layer === 'trace' && e.source_session_id === sid);
  expect(traces).toHaveLength(1);
});

// Bounded window: old session events outside config.autoTraceWindowDays are ignored.
it('skips sessions older than autoTraceWindowDays', () => {
  initStore(tmpDir);
  // Manually age a session_complete event beyond the default 7-day window.
  const sid = 'test-stale';
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // appendSessionEvent with explicit created_at (or poke the DB directly in a test helper)
  appendSessionEvent(tmpDir, {
    session_id: sid, event_type: 'session_complete', content: 'success', source: 'agent',
    created_at: old,  // pretend this happened 30 days ago
  });
  consolidate(tmpDir, { now: new Date() });
  expect(loadAllEntries(tmpDir).filter((e) => e.layer === 'trace')).toHaveLength(0);
});
```

**Step 2: Implement**

New pass in `consolidate()` between decay and replay:

```ts
// 1.4. Auto-promote complete sessions to traces
if (config.autoTraceCapture !== false) {
  const windowDays = config.autoTraceWindowDays ?? 7;
  const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const sessionsToPromote = findPromotableSessions(hippoRoot, sinceMs);

  for (const session of sessionsToPromote) {
    // Idempotency: skip if a trace for this session already exists.
    if (traceExistsForSession(hippoRoot, session.session_id)) continue;

    const events = listSessionEvents(hippoRoot, { session_id: session.session_id });
    const completeEvent = events.find((e) => e.event_type === 'session_complete');
    if (!completeEvent) continue;  // defence in depth — findPromotableSessions already filtered

    const outcome = completeEvent.content as 'success' | 'failure' | 'partial';
    const steps = events
      .filter((e) => e.event_type !== 'session_complete')
      .map((e) => ({ action: e.content, observation: '' }));

    const trace = createMemory(
      renderTraceContent({
        task: (completeEvent.metadata.summary as string) ?? '(untitled)',
        steps,
        outcome,
      }),
      {
        layer: Layer.Trace,
        trace_outcome: outcome,
        source_session_id: session.session_id,
        parents: [],  // provenance via source_session_id column
        tags: ['auto-promoted'],
      }
    );
    pendingWrites.push(trace);
    result.promotedTraces++;
  }
}
```

Helpers (new, in `src/store.ts`):

```ts
export function findPromotableSessions(
  hippoRoot: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  // Returns session_ids with a session_complete event newer than sinceMs.
  initStore(hippoRoot);
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM session_events
      WHERE event_type = 'session_complete' AND created_at >= ?
    `).all(new Date(sinceMs).toISOString()) as { session_id: string }[];
    return rows;
  } finally { closeHippoDb(db); }
}

export function traceExistsForSession(hippoRoot: string, session_id: string): boolean {
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT 1 FROM memories WHERE source_session_id = ? AND layer = 'trace' LIMIT 1
    `).get(session_id);
    return !!row;
  } finally { closeHippoDb(db); }
}
```

Add `promotedTraces: number` to `ConsolidationResult`. Emit a detail line in sleep output.

**Step 3: Pass. Step 4: Commit.**

```bash
git add src/consolidate.ts src/store.ts src/config.ts tests/trace-autopromote.test.ts
git commit -m "feat(consolidate): idempotent, bounded auto-promotion of traces"
```

### Task C2: Skip trace-vs-trace in conflict detection

**Files:**
- Modify: `src/consolidate.ts` (`detectConflicts` filter)
- Extend: `tests/trace-autopromote.test.ts`

**Step 1: Test**

```ts
it('detectConflicts does NOT fire between two trace-layer memories', () => {
  initStore(tmpDir);
  // Two similar successful traces — should NOT conflict
  for (let i = 1; i <= 2; i++) {
    appendSessionEvent(tmpDir, { session_id: `sess-${i}`, event_type: 'action', content: 'refactor auth module', source: 'agent' });
    appendSessionEvent(tmpDir, { session_id: `sess-${i}`, event_type: 'session_complete', content: 'success', source: 'agent' });
  }
  consolidate(tmpDir, { now: new Date() });

  const conflicts = require('../src/store.js').listMemoryConflicts(tmpDir);
  const traceConflicts = conflicts.filter((c: any) => {
    const entries = loadAllEntries(tmpDir);
    const a = entries.find((e) => e.id === c.a_id);
    const b = entries.find((e) => e.id === c.b_id);
    return a?.layer === 'trace' && b?.layer === 'trace';
  });
  expect(traceConflicts).toHaveLength(0);
});
```

**Step 2: Implement**

In `src/consolidate.ts`, inside `detectConflicts`, at the top of the inner loop:

```ts
// Traces are variants of each other, not contradictions.
if (survivors[i].layer === 'trace' && survivors[j].layer === 'trace') continue;
```

**Step 3: Pass + commit.**

```bash
git add src/consolidate.ts tests/trace-autopromote.test.ts
git commit -m "fix(consolidate): skip conflict detection for trace-vs-trace pairs"
```

### Task C3: Inheritance smoke tests

**Files:**
- Create: `tests/trace-inheritance.test.ts`

**Step 1: Write four one-liner smoke tests**

```ts
describe('Trace layer inherits core memory mechanics', () => {
  it('traces decay via the standard strength calculation', () => {
    // A trace with no recent retrieval + old created date should have reduced strength.
    // Assert calculateStrength returns < 1.0 after simulated age.
  });

  it('traces appear in hybridSearch results when text matches', () => {
    // Write a trace, run a recall for content inside it, expect the trace in results.
  });

  it('traces are candidates for the replay pass', () => {
    // Run consolidate with a fresh trace and no other memories; expect result.replayed >= 1
    // or the trace's retrieval_count to increment.
  });

  it('physics state is created for traces on first consolidate', () => {
    // After consolidate, loadPhysicsState should include a particle for the trace id.
  });
});
```

**Step 2: Implement (just write the 4 tests)**

Each is ~10 lines. Purpose is to lock the "inherits for free" claim so a future refactor can't silently break trace behavior.

**Step 3: Pass + commit.**

```bash
git add tests/trace-inheritance.test.ts
git commit -m "test(trace): smoke tests for decay/search/replay/physics inheritance"
```

---

## Phase D — RSI demo

### Task D1: Minimal self-improving agent example

**Files:**
- Create: `examples/rsi-demo/README.md`
- Create: `examples/rsi-demo/agent.mjs`
- Create: `examples/rsi-demo/tasks.json`

**Step 1: Write the demo**

`examples/rsi-demo/agent.mjs`:

A simple loop:
1. Load a task from `tasks.json` (N tasks, 5 trap categories).
2. Before attempting, run `hippo recall <task description> --outcome success --layer trace` via execFileSync.
3. Extract any prior-success strategy from the recall output and bias the agent's choice.
4. Execute the task (mock: stochastic success based on whether the strategy hint matches).
5. Record trace via `hippo trace record`.
6. After all N tasks, report early-vs-late success rate.

Expected output: early success rate lower than late success rate. Measurable learning curve.

**Step 2: Test it runs with a PASS BAR**

The demo must assert its own learning curve, not just print numbers:

```js
// At the end of agent.mjs:
const earlyRate = computeSuccessRate(results.slice(0, 10));
const lateRate = computeSuccessRate(results.slice(-10));
console.error(`Early: ${(earlyRate*100).toFixed(0)}%  Late: ${(lateRate*100).toFixed(0)}%`);
const GAP = 0.20;  // require at least 20pp improvement
if (lateRate - earlyRate < GAP) {
  console.error(`FAIL: learning gap ${(lateRate - earlyRate).toFixed(2)} < required ${GAP}`);
  process.exit(1);
}
console.error(`PASS: learning gap ${(lateRate - earlyRate).toFixed(2)} >= ${GAP}`);
```

Run:

```bash
cd examples/rsi-demo
HIPPO_HOME=/tmp/rsi-demo-global node agent.mjs
echo "Exit code: $?"  # must be 0
```

Expected exit code: 0. Output:

```
Early (tasks 1-10) success rate: 40%
Late (tasks 40-50) success rate: 85%
PASS: learning gap 0.45 >= 0.20
```

A demo without a measurable bar is marketing, not engineering. This bar makes it CI-runnable.

**Step 3: README**

`examples/rsi-demo/README.md`: explain the demo, run command, interpretation. Link from main `README.md` under "Examples".

**Step 4: Commit**

```bash
git add examples/rsi-demo/
git commit -m "docs(examples): minimal recursive-self-improvement demo using traces"
```

---

## Phase E — Docs + ship

### Task E1: CHANGELOG + README

- Add `## Unreleased — Sequence binding (RSI foundation)` to CHANGELOG describing traces + auto-promotion + `hippo trace record` + `--outcome` filter.
- Add a "Recursive self-improvement" section to README under Benchmarks, linking to the RSI demo and the sequential-learning benchmark. Reframe hippo's pitch to highlight RSI alignment.

### Task E2: `/publish-repo` as v0.30.0

This is a MINOR bump — real new feature. Run the skill. Exhaustive doc audit.

---

## Execution order + sizing (post-review)

| Phase | Tasks | Rough time |
|---|---|---|
| A (schema) | A1 → A2 → A3 (migration + v2-with-data test) | 3-4 hours |
| B (record + recall + session complete) | B0 → B1 → B2 → B3 | 4-5 hours |
| C (auto-promote + conflict skip + inheritance tests) | C1 → C2 → C3 | 4-5 hours |
| D (RSI demo with pass bar) | D1 | 2-3 hours |
| E (docs + ship) | E1 → E2 | 1-2 hours |
| **Total** | | **14-19 hours** |

(Up from 11-16 because of the 3 blocker fixes + idempotency + inheritance tests.)

Dependencies: A must complete before B. B0 before C (auto-promote needs the session_complete event type to exist). C1 before C2+C3. D can run in parallel with C2-C3 once A+B+C1 are in. E is last.

## Stop conditions

- Any existing test of the 571 regresses → stop, investigate root cause.
- Schema migration fails on an existing v2 user database (the T-crit test in A3) → stop, do not ship.
- Auto-promotion creates duplicate traces on repeated `hippo sleep` runs (idempotency test fails) → stop, the `source_session_id` guard is broken.
- RSI demo exits non-zero (learning gap < 20pp) → stop, investigate whether retrieval + outcome filtering are actually biasing the strategy.
- Inheritance smoke tests show decay / search / replay / physics NOT applying to trace layer → stop, the "inherits for free" claim is false and needs explicit plumbing.
