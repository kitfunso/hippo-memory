# A3 Provenance Envelope Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the canonical provenance envelope to `memories` so every row carries `kind`, `scope`, `owner`, `artifact_ref`, plus an append-only invariant on `kind='raw'`. Surface the envelope via `hippo recall --why`. Existing eval suites must pass post-migration.

**Architecture:** Migration v14 on `src/db.ts`. Add five nullable columns + one `kind` column with CHECK constraint, default `'distilled'`. Backfill existing rows. Add `BEFORE DELETE` trigger that ABORTs on `kind='raw'`. Add `raw_archive` table as the only legitimate path for raw-row removal (used later by A4 right-to-be-forgotten). Extend `MatchExplanation` to carry envelope. Reuse existing `source_session_id` column as the envelope's `session_id`.

**Tech Stack:** TypeScript, `node:sqlite` (built-in), vitest, real SQLite per project rule (no mocks).

**Roadmap source:** ROADMAP-RESEARCH.md (commit 66152d3) §"Track A — A3" + §"Schema migration order" + §"Test commitments".

**Effort budget:** 6-8 weeks single-engineer cadence.

---

## Pre-flight: Schema before/after

```
BEFORE (v13)                          AFTER (v14)
┌────────────────────────┐           ┌────────────────────────┐
│ memories               │           │ memories               │
│   id PK                │           │   id PK                │
│   created              │           │   created              │
│   last_retrieved       │           │   last_retrieved       │
│   retrieval_count      │           │   retrieval_count      │
│   strength             │           │   strength             │
│   half_life_days       │           │   half_life_days       │
│   layer                │           │   layer                │
│   tags_json            │           │   tags_json            │
│   emotional_valence    │           │   emotional_valence    │
│   schema_fit           │           │   schema_fit           │
│   source               │           │   source               │
│   outcome_score        │           │   outcome_score        │
│   outcome_positive     │           │   outcome_positive     │
│   outcome_negative     │           │   outcome_negative     │
│   conflicts_with_json  │           │   conflicts_with_json  │
│   pinned               │           │   pinned               │
│   confidence (text)    │           │   confidence (text)    │
│   content              │           │   content              │
│   updated_at           │           │   updated_at           │
│   parents_json         │           │   parents_json         │
│   starred              │           │   starred              │
│   trace_outcome        │           │   trace_outcome        │
│   source_session_id    │◄─────────►│   source_session_id    │  reused as envelope.session_id
│   valid_from           │           │   valid_from           │
│   superseded_by        │           │   superseded_by        │
│   extracted_from       │           │   extracted_from       │
│   dag_level            │           │   dag_level            │
│   dag_parent_id        │     +     │   dag_parent_id        │
└────────────────────────┘           │   kind             NEW │  CHECK IN (raw,distilled,superseded)
                                     │   scope            NEW │
                                     │   owner            NEW │
                                     │   artifact_ref     NEW │
                                     └────────────────────────┘
                                                +
                                     ┌────────────────────────┐
                                     │ raw_archive        NEW │  legitimate path for kind=raw removal
                                     │   id PK                │
                                     │   memory_id (was raw)  │
                                     │   archived_at          │
                                     │   reason               │
                                     │   archived_by          │
                                     │   payload_json         │  full row snapshot pre-delete
                                     └────────────────────────┘
                                                +
                                     TRIGGER: trg_memories_raw_append_only
                                     BEFORE DELETE ON memories
                                     WHEN OLD.kind = 'raw'
                                     BEGIN SELECT RAISE(ABORT, 'raw is append-only'); END;
```

**Invariant after this lands:** `DELETE FROM memories WHERE kind='raw'` is impossible from app code. The only path to remove a `kind='raw'` row is via `archiveRawMemory(id, reason, who)` which (1) snapshots into `raw_archive`, (2) updates `kind` to `'archived'`, (3) deletes the row in a single transaction. (Trigger only fires for `kind='raw'`; once `kind='archived'`, delete proceeds.)

---

## Task 0: Decision doc — pin envelope shape before code

**Files:**
- Create: `docs/plans/2026-04-29-a3-envelope-decisions.md`

**Why this is a task:** A3 mistakes force re-migration later (per ROADMAP-RESEARCH.md). Pin column types, CHECK constraint, default values, NULL semantics before writing migration code.

**Step 1: Draft the decision doc**

Capture exact decisions:
- `kind TEXT NOT NULL DEFAULT 'distilled' CHECK (kind IN ('raw','distilled','superseded','archived'))` — `'archived'` is the post-deletion sentinel value used by the trigger workaround
- `scope TEXT` (nullable; NULL = "global / un-scoped"; deferred to A5 for tenant semantics)
- `owner TEXT` (nullable; user/agent identifier; format: `user:<id>` or `agent:<id>`)
- `artifact_ref TEXT` (nullable; URI to source artifact: `slack://team/channel/ts`, `gh://owner/repo/pr/123`, `file:///abs/path`)
- `session_id` — reuse existing `source_session_id` column. Document this aliasing in `MEMORY_ENVELOPE.md`.
- `confidence` — already exists as TEXT (`verified | observed | inferred | stale`). Keep, no change.
- `timestamp` — already covered by `created`. No new column.

**Backfill plan:**
- Existing rows: `kind = 'distilled'` (existing memories went through some processing; none are raw transcripts).
- `superseded_by IS NOT NULL` rows: `kind = 'superseded'`.
- `scope`, `owner`, `artifact_ref`: leave NULL; populated as new connectors land.

**Step 2: Commit**

```bash
git add docs/plans/2026-04-29-a3-envelope-decisions.md
git commit -m "docs(a3): pin envelope column types + backfill semantics"
```

---

## Task 1: Migration v14 skeleton — bump version, add stub

**Files:**
- Modify: `src/db.ts:24` (bump `CURRENT_SCHEMA_VERSION` to 14)
- Modify: `src/db.ts:259` (append migration object to `MIGRATIONS` array)

**Step 1: Write the failing test**

Create `tests/a3-envelope-migration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, getCurrentSchemaVersion, getSchemaVersion, closeHippoDb } from '../src/db.js';

describe('A3 envelope migration v14', () => {
  it('CURRENT_SCHEMA_VERSION is 14', () => {
    expect(getCurrentSchemaVersion()).toBe(14);
  });

  it('fresh db migrates to v14', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(getSchemaVersion(db)).toBe(14);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd C:/Users/skf_s/hippo && npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: FAIL — `getCurrentSchemaVersion()` returns 13, not 14.

**Step 3: Bump constant**

Edit `src/db.ts:24`:
```typescript
const CURRENT_SCHEMA_VERSION = 14;
```

Edit `src/db.ts` (append to `MIGRATIONS` array before the closing `]`):
```typescript
{
  version: 14,
  up: (db) => {
    // populated in subsequent tasks
  },
},
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: PASS (both tests).

**Step 5: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): bump schema version to 14 with empty migration"
```

---

## Task 2: Add `kind` column with CHECK and default

**Files:**
- Modify: `src/db.ts` (migration v14 body)
- Modify: `tests/a3-envelope-migration.test.ts`

**Step 1: Write the failing test**

Append to `tests/a3-envelope-migration.test.ts`:

```typescript
it('memories table has kind column with default distilled', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string; dflt_value: string | null }>;
  const kind = cols.find((c) => c.name === 'kind');
  expect(kind).toBeDefined();
  expect(kind!.dflt_value).toContain('distilled');
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});

it('rejects kind value outside CHECK set', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  const insert = () =>
    db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('x', '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', 'neutral', 0.5, 'test', '[]', 0, 'observed', 'c', 'bogus')`).run();
  expect(insert).toThrow(/CHECK constraint/i);
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 2: Run test, verify fail**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: FAIL — column does not exist.

**Step 3: Add column in migration v14 `up`**

Replace the v14 stub with:

```typescript
{
  version: 14,
  up: (db) => {
    if (!tableHasColumn(db, 'memories', 'kind')) {
      // SQLite ALTER TABLE ADD COLUMN can't add CHECK; recreate table column via temp+swap is heavy.
      // Instead: add nullable column, backfill, then enforce via app-layer + trigger.
      db.exec(`ALTER TABLE memories ADD COLUMN kind TEXT DEFAULT 'distilled'`);
      // Enforce CHECK via a separate trigger (added in Task 4) since ALTER cannot add CHECK.
    }
  },
},
```

**Note:** SQLite `ALTER TABLE ADD COLUMN` cannot add a CHECK constraint. We enforce `kind IN (...)` via a `BEFORE INSERT/UPDATE` trigger in Task 4. The "rejects kind value outside CHECK set" test will pass once that trigger lands; for now, mark it as `it.todo`:

```typescript
it.todo('rejects kind value outside CHECK set — Task 4');
```

**Step 4: Run, expect default-value test passes**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: PASS for default-value test; CHECK test marked todo.

**Step 5: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): add kind column with default distilled"
```

---

## Task 3: Add `scope`, `owner`, `artifact_ref` columns (nullable)

**Files:**
- Modify: `src/db.ts` (migration v14)
- Modify: `tests/a3-envelope-migration.test.ts`

**Step 1: Write the failing test**

Append:

```typescript
it.each(['scope', 'owner', 'artifact_ref'])('memories table has nullable %s column', (col) => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string; notnull: number }>;
  const c = cols.find((x) => x.name === col);
  expect(c).toBeDefined();
  expect(c!.notnull).toBe(0);
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 2: Run, verify fail**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: FAIL on all three.

**Step 3: Extend migration v14**

```typescript
if (!tableHasColumn(db, 'memories', 'scope')) {
  db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL`);
}
if (!tableHasColumn(db, 'memories', 'owner')) {
  db.exec(`ALTER TABLE memories ADD COLUMN owner TEXT`);
}
if (!tableHasColumn(db, 'memories', 'artifact_ref')) {
  db.exec(`ALTER TABLE memories ADD COLUMN artifact_ref TEXT`);
}
```

**Step 4: Run, expect pass**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): add scope, owner, artifact_ref columns"
```

---

## Task 4: Backfill `kind` for existing rows

**Files:**
- Modify: `src/db.ts` (migration v14)
- Modify: `tests/a3-envelope-migration.test.ts`

**Step 1: Write the failing test**

Append:

```typescript
it('backfills kind=superseded for rows with superseded_by set', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  // Open with v14 to set up table, then write a v13-style row to simulate pre-migration data
  const db = openHippoDb(home);
  // Insert a row with superseded_by, kind = NULL (simulating pre-migration state)
  db.prepare(`UPDATE memories SET kind = NULL WHERE 1=1`).run();  // null out so we can test backfill idempotently
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, superseded_by, kind) VALUES ('s1', '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', 'neutral', 0.5, 'test', '[]', 0, 'observed', 'old', 's2', NULL)`).run();
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, superseded_by, kind) VALUES ('s2', '2026-01-01', '2026-01-01', 0, 1.0, 7, 'episodic', '[]', 'neutral', 0.5, 'test', '[]', 0, 'observed', 'new', NULL, NULL)`).run();
  // Re-run backfill manually (idempotent)
  db.exec(`UPDATE memories SET kind = 'superseded' WHERE superseded_by IS NOT NULL AND kind IS NULL`);
  db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
  const s1 = db.prepare(`SELECT kind FROM memories WHERE id='s1'`).get() as { kind: string };
  const s2 = db.prepare(`SELECT kind FROM memories WHERE id='s2'`).get() as { kind: string };
  expect(s1.kind).toBe('superseded');
  expect(s2.kind).toBe('distilled');
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 2: Run, verify fail (no backfill yet in migration)**

Expected: PASS for the assertions because the test does the UPDATE itself; we need a stronger test that asserts the migration does it. Replace the test with one that runs the migration on a v13-shaped DB.

**Better test (replace the above):**

```typescript
it('migration v14 backfills kind from superseded_by on real upgrade path', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  // Force v13 first by manipulating CURRENT_SCHEMA_VERSION? Cleaner: open DB, write rows with kind=NULL,
  // then run the backfill SQL directly to verify the SQL is correct.
  const db = openHippoDb(home);
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, superseded_by) VALUES ('s1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','x','s2')`).run();
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content) VALUES ('s2','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','y')`).run();
  // After migration default sets kind='distilled' on insert; verify migration also fixes superseded
  const s1 = db.prepare(`SELECT kind FROM memories WHERE id='s1'`).get() as { kind: string };
  expect(s1.kind).toBe('superseded');
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 3: Add backfill to migration v14**

```typescript
// Backfill kind for any rows where it's NULL (pre-migration data)
db.exec(`UPDATE memories SET kind = 'superseded' WHERE kind IS NULL AND superseded_by IS NOT NULL`);
db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
```

**Step 4: Run, expect pass**

Expected: PASS.

**Step 5: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): backfill kind for existing memories"
```

---

## Task 5: Add `raw_archive` table

**Files:**
- Modify: `src/db.ts` (migration v14)
- Modify: `tests/a3-envelope-migration.test.ts`

**Step 1: Write the failing test**

```typescript
it('raw_archive table exists with required columns', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  const cols = db.prepare(`PRAGMA table_info(raw_archive)`).all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(['id', 'memory_id', 'archived_at', 'reason', 'archived_by', 'payload_json']));
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 2: Run, verify fail**

Expected: FAIL — table does not exist.

**Step 3: Add to migration v14**

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS raw_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    archived_by TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_raw_archive_memory_id ON raw_archive(memory_id);
`);
```

**Step 4: Run, expect pass.**

**Step 5: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): add raw_archive table for retention deletions"
```

---

## Task 6: Append-only trigger on `kind='raw'`

**Files:**
- Modify: `src/db.ts` (migration v14)
- Modify: `tests/a3-envelope-migration.test.ts`

**Step 1: Write the failing CRITICAL REGRESSION test**

```typescript
it('CRITICAL REGRESSION: DELETE on kind=raw aborts via trigger', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('r1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','raw')`).run();
  expect(() => db.prepare(`DELETE FROM memories WHERE id='r1'`).run()).toThrow(/raw is append-only/);
  // Row still there
  const row = db.prepare(`SELECT id FROM memories WHERE id='r1'`).get();
  expect(row).toBeDefined();
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});

it('DELETE on kind=distilled proceeds normally', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('d1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`).run();
  db.prepare(`DELETE FROM memories WHERE id='d1'`).run();
  const row = db.prepare(`SELECT id FROM memories WHERE id='d1'`).get();
  expect(row).toBeUndefined();
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 2: Add CHECK enforcement trigger as well (replaces the `it.todo` from Task 2)**

```typescript
it('rejects kind value outside the allowed set', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
  const db = openHippoDb(home);
  expect(() =>
    db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('b1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','bogus')`).run()
  ).toThrow(/invalid kind/i);
  closeHippoDb(db);
  rmSync(home, { recursive: true, force: true });
});
```

**Step 3: Run, verify fail**

Expected: FAIL on all three (no triggers).

**Step 4: Add triggers to migration v14**

```typescript
// Append-only invariant: kind='raw' rows cannot be deleted directly.
// Use raw_archive flow: archive-then-update-then-delete.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_memories_raw_append_only
  BEFORE DELETE ON memories
  WHEN OLD.kind = 'raw'
  BEGIN
    SELECT RAISE(ABORT, 'raw is append-only');
  END;
`);

// CHECK substitute: ALTER TABLE cannot add CHECK, so enforce via INSERT/UPDATE triggers.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_insert
  BEFORE INSERT ON memories
  WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
  BEGIN
    SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
  END;
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_update
  BEFORE UPDATE ON memories
  WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
  BEGIN
    SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
  END;
`);
```

**Step 5: Run, expect pass on all three.**

```bash
npx vitest run tests/a3-envelope-migration.test.ts
```

**Step 6: Commit**

```bash
git add src/db.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): append-only trigger on kind=raw + kind CHECK enforcement"
```

---

## Task 7: `archiveRawMemory` function — the only legitimate raw-deletion path

**Files:**
- Create: `src/raw-archive.ts`
- Create: `tests/raw-archive.test.ts`

**Step 1: Write the failing test**

`tests/raw-archive.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { archiveRawMemory } from '../src/raw-archive.js';

describe('archiveRawMemory', () => {
  it('snapshots row into raw_archive then removes it from memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-arch-'));
    const db = openHippoDb(home);
    db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('r1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','sensitive content','raw')`).run();
    archiveRawMemory(db, 'r1', { reason: 'GDPR right-to-be-forgotten', who: 'user:42' });
    const remaining = db.prepare(`SELECT id FROM memories WHERE id='r1'`).get();
    expect(remaining).toBeUndefined();
    const archived = db.prepare(`SELECT memory_id, reason, archived_by FROM raw_archive WHERE memory_id='r1'`).get() as { memory_id: string; reason: string; archived_by: string };
    expect(archived.memory_id).toBe('r1');
    expect(archived.reason).toBe('GDPR right-to-be-forgotten');
    expect(archived.archived_by).toBe('user:42');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to archive non-raw memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-arch-'));
    const db = openHippoDb(home);
    db.prepare(`INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('d1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`).run();
    expect(() => archiveRawMemory(db, 'd1', { reason: 'test', who: 'user:1' })).toThrow(/not raw/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
```

**Step 2: Run, verify fail (module not found)**

**Step 3: Write `src/raw-archive.ts`:**

```typescript
import type { DatabaseSyncLike } from './db.js';

export interface ArchiveOpts {
  reason: string;
  who: string;
}

export function archiveRawMemory(db: DatabaseSyncLike, id: string, opts: ArchiveOpts): void {
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`memory not found: ${id}`);
  if (row.kind !== 'raw') throw new Error(`memory ${id} is not raw (kind=${row.kind})`);

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      new Date().toISOString(),
      opts.reason,
      opts.who,
      JSON.stringify(row),
    );
    // Flip kind to 'archived' so the trigger doesn't fire, then delete.
    db.prepare(`UPDATE memories SET kind = 'archived' WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
```

**Step 4: Run, expect pass.**

**Step 5: Commit**

```bash
git add src/raw-archive.ts tests/raw-archive.test.ts
git commit -m "feat(a3): archiveRawMemory function for legitimate raw deletions"
```

---

## Task 8: Extend `MemoryEntry` TS type + `createMemory` factory

**Files:**
- Modify: `src/memory.ts` (add envelope fields to type + factory opts)

**Step 1: Read current `src/memory.ts` to understand factory signature**

```bash
grep -n "createMemory\|interface MemoryEntry\|export type" src/memory.ts | head -20
```

**Step 2: Write the failing test**

Append to `tests/a3-envelope-migration.test.ts`:

```typescript
import { createMemory, Layer } from '../src/memory.js';
import { writeEntry, readEntry } from '../src/store.js';

it('createMemory accepts envelope fields and round-trips through SQLite', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mem-'));
  // initStore is in store.ts; pattern matches bi-temporal-migration.test.ts
  const e = createMemory('slack message ingested', {
    layer: Layer.Episodic,
    kind: 'raw',
    scope: 'team:eng',
    owner: 'user:42',
    artifact_ref: 'slack://team/channel/1700000000.123',
  });
  // ...write/read
  expect(e.kind).toBe('raw');
  expect(e.scope).toBe('team:eng');
  expect(e.owner).toBe('user:42');
  expect(e.artifact_ref).toBe('slack://team/channel/1700000000.123');
  rmSync(home, { recursive: true, force: true });
});
```

**Step 3: Extend `MemoryEntry` interface + `createMemory` factory**

In `src/memory.ts`, add to the entry type:

```typescript
export type MemoryKind = 'raw' | 'distilled' | 'superseded' | 'archived';

export interface MemoryEntry {
  // ... existing fields
  kind: MemoryKind;
  scope: string | null;
  owner: string | null;
  artifact_ref: string | null;
}

export interface CreateMemoryOpts {
  // ... existing
  kind?: MemoryKind;
  scope?: string | null;
  owner?: string | null;
  artifact_ref?: string | null;
}
```

In `createMemory`:
```typescript
return {
  // ... existing
  kind: opts.kind ?? 'distilled',
  scope: opts.scope ?? null,
  owner: opts.owner ?? null,
  artifact_ref: opts.artifact_ref ?? null,
};
```

**Step 4: Update `src/store.ts` `writeEntry`/`readEntry` to persist + restore the new fields.** Follow the existing pattern for `valid_from` (added in v11) — same shape.

**Step 5: Run all tests, expect pass.**

```bash
npx vitest run
```

If existing tests fail because they construct memories without envelope fields: that's expected because TypeScript compilation should still pass (all new fields are optional in `CreateMemoryOpts`, defaults apply). If runtime tests fail because of NULL handling, that's the bug to fix.

**Step 6: Commit**

```bash
git add src/memory.ts src/store.ts tests/a3-envelope-migration.test.ts
git commit -m "feat(a3): extend MemoryEntry type + createMemory factory with envelope"
```

---

## Task 9: Surface envelope through `--why`

**Files:**
- Modify: `src/search.ts` (extend `MatchExplanation` interface around line 958)
- Modify: `src/cli.ts` (`recall --why` formatter)
- Create: `tests/recall-why-envelope.test.ts`

**Step 1: Inspect existing MatchExplanation**

```bash
grep -n "MatchExplanation\|--why" src/search.ts src/cli.ts | head -30
```

**Step 2: Write the failing test**

`tests/recall-why-envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

describe('hippo recall --why exposes envelope', () => {
  it('output includes kind, scope, owner, artifact_ref', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-why-'));
    const env = { ...process.env, HIPPO_HOME: home };
    execSync(`node dist/cli.js remember "production deploy ran clean" --kind=distilled --scope=team:eng --owner=user:42 --artifact-ref=gh://owner/repo/pr/123`, { env });
    const out = execSync(`node dist/cli.js recall "production deploy" --why`, { env }).toString();
    expect(out).toContain('kind: distilled');
    expect(out).toContain('scope: team:eng');
    expect(out).toContain('owner: user:42');
    expect(out).toContain('artifact_ref: gh://owner/repo/pr/123');
    rmSync(home, { recursive: true, force: true });
  });
});
```

This test requires `hippo remember` to accept envelope flags (next sub-step) and `dist/cli.js` to be built.

**Step 3: Extend `MatchExplanation` to include envelope fields**

Around `src/search.ts:958`:

```typescript
export interface MatchExplanation {
  // ... existing fields
  envelope?: {
    kind: string;
    scope: string | null;
    owner: string | null;
    artifact_ref: string | null;
    session_id: string | null;
    confidence: string;
  };
}
```

Populate it from the row when assembling the explanation.

**Step 4: Add envelope flags to `hippo remember`**

In `src/cli.ts`, the `remember` command parser needs new options:
```typescript
.option('--kind <kind>', 'envelope kind: raw|distilled|superseded', 'distilled')
.option('--scope <scope>', 'memory scope (e.g. team:eng)')
.option('--owner <owner>', 'owner identifier (user:id | agent:id)')
.option('--artifact-ref <uri>', 'source artifact URI')
```

Wire them through to `createMemory`.

**Step 5: Update the `--why` formatter**

In the recall output formatter for `--why`, append envelope lines:
```typescript
if (m.envelope) {
  lines.push(`  kind: ${m.envelope.kind}`);
  if (m.envelope.scope) lines.push(`  scope: ${m.envelope.scope}`);
  if (m.envelope.owner) lines.push(`  owner: ${m.envelope.owner}`);
  if (m.envelope.artifact_ref) lines.push(`  artifact_ref: ${m.envelope.artifact_ref}`);
  if (m.envelope.session_id) lines.push(`  session_id: ${m.envelope.session_id}`);
  lines.push(`  confidence: ${m.envelope.confidence}`);
}
```

**Step 6: Build and run the test**

```bash
npm run build && npx vitest run tests/recall-why-envelope.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/search.ts src/cli.ts tests/recall-why-envelope.test.ts
git commit -m "feat(a3): surface envelope via hippo recall --why"
```

---

## Task 10: Backwards-compat — existing eval suites must pass

**Files:**
- No code changes expected. Verification step.

**Step 1: Run LongMemEval R@5 baseline**

```bash
npm run build
node benchmarks/longmemeval/run.js --top-k 5 > /tmp/longmemeval-post-a3.txt
```

Compare against pre-A3 baseline. **Acceptance:** R@5 within ±1pp of pre-migration number. If it drops more, A3 broke something.

**Step 2: Run fire-rate paired A/B harness**

```bash
node benchmarks/fire-rate/paired-ab.js --baseline pre-a3 --candidate current
```

**Acceptance:** Wilcoxon p > 0.05 (no regression).

**Step 3: Run full vitest suite**

```bash
npx vitest run
```

**Acceptance:** all green.

**Step 4: Commit eval results to `docs/plans/cuts.md` or similar audit log**

```bash
git add docs/plans/2026-04-29-a3-eval-results.md
git commit -m "docs(a3): post-migration eval results — within tolerance"
```

If any of the three steps fails, STOP. Do not proceed to Task 11. Diagnose and fix.

---

## Task 11: Documentation — `MEMORY_ENVELOPE.md` reference

**Files:**
- Create: `MEMORY_ENVELOPE.md`

**Step 1: Document each field**

```markdown
# Memory envelope

Every row in `memories` carries the canonical envelope:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | TEXT | yes | `raw \| distilled \| superseded \| archived`. Default `distilled`. Append-only when `kind='raw'`. |
| `scope` | TEXT | no | NULL = global. Format: `team:<id>`, `project:<id>`, `customer:<id>`. A5 will tighten semantics. |
| `owner` | TEXT | no | `user:<id>` or `agent:<id>`. |
| `artifact_ref` | TEXT | no | URI to source: `slack://`, `gh://`, `file://`. |
| `session_id` | TEXT | no | Aliased to existing `source_session_id` column. |
| `confidence` | TEXT | yes | `verified \| observed \| inferred \| stale`. Existing field, repurposed. |
| `created` | TEXT | yes | Existing timestamp; satisfies envelope `timestamp`. |

## Invariants

1. `kind='raw'` rows cannot be deleted directly. Use `archiveRawMemory(db, id, { reason, who })`.
2. `kind` is constrained to the allowed set via INSERT/UPDATE triggers.
3. New tables introduced after v14 must include `kind` and (post-A5) `tenant_id`.
```

**Step 2: Commit**

```bash
git add MEMORY_ENVELOPE.md
git commit -m "docs(a3): MEMORY_ENVELOPE.md reference"
```

---

## Task 12: Update ROADMAP-RESEARCH.md status

**Step 1: Mark A3 as `[shipped]`**

In `ROADMAP-RESEARCH.md`, change `### A3. Provenance envelope [next]` to `[shipped]`. Add commit hash reference.

**Step 2: Commit**

```bash
git add ROADMAP-RESEARCH.md
git commit -m "docs(roadmap): mark A3 envelope as shipped"
```

---

## Sub-task sequencing summary

```
Task 0  decision doc       (1d)
Task 1  bump v14 stub      (0.5d)
Task 2  kind column        (1d)
Task 3  scope/owner/ref    (1d)
Task 4  backfill           (2d)  ← real-data risk concentrated here
Task 5  raw_archive table  (1d)
Task 6  triggers           (3d)  ← CRITICAL REGRESSION + CHECK substitute
Task 7  archiveRawMemory   (3d)
Task 8  type + factory     (4d)
Task 9  --why CLI          (5d)
Task 10 eval re-run        (3d)  ← stop-the-line gate
Task 11 docs               (1d)
Task 12 roadmap update     (0.5d)
        ────────────────────────
        Total              ~26d (~5w pure work + 1-2w slippage = 6-7w calendar)
```

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `ALTER TABLE ADD COLUMN` cannot add CHECK | Use INSERT/UPDATE triggers (Task 6) |
| Existing rows get wrong default `kind` | Backfill rule based on `superseded_by` (Task 4); manual audit of first 100 rows post-migration |
| `--why` output breaks downstream parsers | Envelope fields are additive; existing fields unchanged. Snapshot-test the formatter |
| LongMemEval regression | Task 10 is a stop-the-line gate; rollback plan = revert v14 migration |
| Existing tests pass NULL for envelope and break | TS optional fields default to null/distilled in `createMemory`; no caller change required |
| Trigger fires on legitimate sleep-cycle deletes | Sleep deletes operate on `kind='distilled'` (decay); trigger only catches `kind='raw'`. Verified in Task 6 second test |
| `raw_archive` grows unbounded | A4 (right-to-be-forgotten) handles retention. Out of scope here; flag in MEMORY_ENVELOPE.md |

---

## What is NOT in scope (explicit)

- `tenant_id` / multi-tenancy isolation — A5
- Encryption-at-rest — A4
- Secret-scrub at write-time — A4
- PII redaction — A4
- Right-to-be-forgotten end-to-end flow — A4 (only the `archiveRawMemory` primitive lands here)
- Connector code that writes `kind='raw'` rows — E1.3 Slack, etc.
- Graph extraction queue (`graph_extraction_queue` table) — E3.1, lands separately

---

## Acceptance checklist

- [ ] `getCurrentSchemaVersion()` returns 14
- [ ] `memories.kind` exists with default `'distilled'`
- [ ] `memories.scope`, `owner`, `artifact_ref` exist (nullable)
- [ ] Existing rows: `kind='superseded'` where `superseded_by IS NOT NULL`, else `'distilled'`
- [ ] `raw_archive` table exists with required columns
- [ ] DELETE on `kind='raw'` raises `'raw is append-only'`
- [ ] DELETE on `kind='distilled'` proceeds normally
- [ ] INSERT/UPDATE with invalid `kind` raises `'invalid kind: ...'`
- [ ] `archiveRawMemory` snapshots into `raw_archive` then removes the row in one transaction
- [ ] `archiveRawMemory` refuses non-raw rows
- [ ] `createMemory({ kind, scope, owner, artifact_ref })` round-trips through SQLite
- [ ] `hippo remember --kind --scope --owner --artifact-ref` works
- [ ] `hippo recall --why` shows envelope lines
- [ ] LongMemEval R@5 within ±1pp of pre-A3 baseline
- [ ] Fire-rate Wilcoxon p > 0.05 (no regression)
- [ ] Full vitest suite green
- [ ] `MEMORY_ENVELOPE.md` written
- [ ] ROADMAP-RESEARCH.md A3 marked `[shipped]`
