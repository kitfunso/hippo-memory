# Bi-Temporal Memory Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support "correction without deletion" — when a new memory supersedes an old one, keep the old as historical truth, default recall to current-only, optionally query "as of" a past date.

**Why:** Corrections are the #1 reason memories get lost. Today, the user runs `hippo forget` (or we decay it). That erases history. Zep's bi-temporal graph is the reference design; we match it with one table, two columns, one command.

**Architecture:** Add two columns (`valid_from`, `superseded_by`) to `memories`. Default recall filters superseded. New `hippo supersede` command creates a successor memory and links the old → new. No breaking changes: existing memories have `superseded_by = NULL` (always current).

**Tech Stack:** TypeScript, node:sqlite migration v11, vitest. No new deps.

---

## Context (for the executor)

Existing infra:
- Migrations: `src/db.ts:31-220`, array-driven. v10 is current. Add v11.
- `MemoryEntry` interface: `src/memory.ts:21-48` + `createMemory()` at line ~230.
- Column select list: `src/store.ts` has `MEMORY_SELECT_COLUMNS` constant (added in v10) — update there.
- `writeEntry` / `readEntry` / `loadAllEntries` in store.ts — field persistence.
- Recall: `cmdRecall` at `src/cli.ts:~560`. Default filter goes here.
- Conflict detection: `src/consolidate.ts detectConflicts()`. Skip superseded pairs.
- `markRetrieved` at `src/search.ts` — don't strengthen superseded.

**Non-negotiables:**
- Schema migration is ADDITIVE only. `ALTER TABLE ... ADD COLUMN`. No DROP, no data transform.
- Migration must be reentrant (check `tableHasColumn` before ALTER).
- Backward compat: existing stores with `superseded_by = NULL` behave exactly as before.
- Use real node:sqlite in tests, not mocks.

---

## Design decisions (locked, no drift)

1. **Two columns, not three.** `valid_from TEXT NOT NULL DEFAULT (created)` + `superseded_by TEXT`. Valid-to is derived from the successor's valid_from when needed.
2. **Default recall is current-only.** Superseded memories drop out unless `--include-superseded` or `--as-of <date>` is passed.
3. **Default decay applies to superseded.** They fade like anything else. Cheap, keeps DB lean.
4. **Superseded memories skip conflict detection.** No point flagging "these contradict" when one is historically-dead.
5. **Retrieval of superseded does NOT strengthen.** `markRetrieved` is a no-op on superseded entries. Historical reads shouldn't revive dead beliefs.
6. **Supersession is a one-way arrow.** Chains allowed (A → B → C). No cycles (enforced at write time via existence check on the old id's `superseded_by`).
7. **`hippo supersede <old-id> "<new content>" [flags]`** creates a new memory and links the old one. Reusing flags from `remember` (`--layer`, `--scope`, `--pin`, `--tag`).
8. **`--as-of <ISO-date>`** on recall/context filters to memories whose `valid_from <= date` AND (`superseded_by IS NULL` OR `successor.valid_from > date`). This is the hard query; implement in step 3, write test first.

---

## Task 1: Schema v11 migration + MemoryEntry fields

**Files:**
- Modify: `src/db.ts` (append migration v11 to `MIGRATIONS` array)
- Modify: `src/memory.ts` (add `valid_from: string`, `superseded_by: string | null` to `MemoryEntry`; add validation in `createMemory`)
- Modify: `src/store.ts` (extend `MEMORY_SELECT_COLUMNS` with the new columns; update row-to-entry / entry-to-row mapping)
- Test: `tests/bi-temporal-migration.test.ts` (new)

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

describe('bi-temporal schema v11', () => {
  it('new entries have valid_from defaulting to created and superseded_by null', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-bt-'));
    initStore(home);
    const e = createMemory('test', { layer: Layer.Episodic });
    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read?.valid_from).toBe(e.created);
    expect(read?.superseded_by).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('v10 store with data migrates to v11 without loss', () => {
    // Seed a v10 store manually, run migrations, verify data + new columns present.
    // Use openDatabase directly to avoid triggering migration before seed.
    // (Detailed body in executor: seed meta.schema_version=10, insert a row,
    // close, reopen via initStore to run migration, verify row intact + valid_from populated.)
  });
});
```

**Step 2: Run test → FAIL** (no columns yet).

**Step 3: Implement migration v11**

In `src/db.ts` `MIGRATIONS`:

```ts
{
  version: 11,
  up: (db) => {
    if (!tableHasColumn(db, 'memories', 'valid_from')) {
      db.exec(`ALTER TABLE memories ADD COLUMN valid_from TEXT`);
      // Backfill existing rows: valid_from = created.
      db.exec(`UPDATE memories SET valid_from = created WHERE valid_from IS NULL`);
    }
    if (!tableHasColumn(db, 'memories', 'superseded_by')) {
      db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`);
    }
    // Partial index for fast "current only" queries (by far the common path).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL`);
  },
},
```

**Step 4: Extend MemoryEntry and createMemory**

In `src/memory.ts`:
- Add `valid_from: string;` and `superseded_by: string | null;` to `MemoryEntry`.
- In `createMemory`: set `valid_from = now` (same as `created` by default), `superseded_by = null`.
- Accept optional `valid_from` override in options for backfilling historical facts (future-proof, but no CLI surface yet).

**Step 5: Update store.ts column list + mapping**

Add `valid_from`, `superseded_by` to `MEMORY_SELECT_COLUMNS`. Update the SQL INSERT/UPDATE in `writeEntry` to include them. Update the row-to-entry mapper.

**Step 6: Run test → PASS. Full suite → PASS.**

```bash
npm run build && npx vitest run
```

**Step 7: Commit**

```bash
git add src/db.ts src/memory.ts src/store.ts tests/bi-temporal-migration.test.ts
git commit -m "feat(bi-temporal): schema v11 adds valid_from + superseded_by"
```

---

## Task 2: `hippo supersede` command

**Files:**
- Modify: `src/cli.ts` (new `cmdSupersede` function + switch case)
- Test: `tests/cli-supersede.test.ts` (new)

**Step 1: Failing test**

```ts
describe('hippo supersede', () => {
  it('creates new memory, links old one via superseded_by', () => {
    // init temp HIPPO_HOME
    // hippo remember "X is true"
    // get id
    // hippo supersede <id> "X is false now"
    // hippo recall finds "X is false" but not "X is true" (default filters superseded)
  });

  it('--include-superseded shows the historical memory', () => {
    // as above, then hippo recall --include-superseded finds both
  });

  it('errors if old id does not exist', () => {
    // hippo supersede mem_does_not_exist "anything" → exit 1
  });

  it('errors if old id is already superseded (cycle prevention)', () => {
    // supersede A → B, then supersede A → C should error
    // "memory mem_A is already superseded by mem_B; supersede mem_B instead"
  });
});
```

**Step 2: Run test → FAIL.**

**Step 3: Implement**

`cmdSupersede(hippoRoot, args, flags)`:
1. Parse: `args[0]` = old-id, `args.slice(1).join(' ')` = new content.
2. Load old entry. If missing → error. If `superseded_by !== null` → error with helpful message.
3. Create new memory via `createMemory(content, {...flags-derived options})`. 
4. Set `oldEntry.superseded_by = newEntry.id`. `writeEntry(hippoRoot, oldEntry)`.
5. `writeEntry(hippoRoot, newEntry)`. Auto-embed if available.
6. Print: `Superseded mem_<old> → mem_<new>`.

Wire into dispatch at `cli.ts:~3990` switch.

**Step 4: Pass → commit**

```bash
git add src/cli.ts tests/cli-supersede.test.ts
git commit -m "feat(bi-temporal): hippo supersede command"
```

---

## Task 3: Default recall filter + `--include-superseded` + `--as-of`

**Files:**
- Modify: `src/search.ts` (filter logic in `hybridSearch` and `search`)
- Modify: `src/cli.ts` (`cmdRecall`, `cmdContext`, `cmdExplain` flag parsing + passthrough)
- Modify: `src/consolidate.ts` (skip superseded in `detectConflicts`)
- Test: `tests/bi-temporal-recall.test.ts` (new)

**Step 1: Failing tests**

```ts
describe('recall with bi-temporal filter', () => {
  it('default recall excludes superseded memories', () => { /* ... */ });
  it('--include-superseded returns them with a marker in output', () => { /* ... */ });
  it('--as-of <date> returns memories current at that date', () => { /* ... */ });
  it('markRetrieved is no-op for superseded memories', () => { /* ... */ });
  it('detectConflicts skips pairs where one side is superseded', () => { /* ... */ });
});
```

**Step 2: Implement**

In `search.ts hybridSearch` and `search` functions:
- Accept `options.includeSuperseded?: boolean` and `options.asOf?: Date`.
- Before scoring, filter `entries`:
  - If `asOf`: keep entries where `new Date(entry.valid_from) <= asOf` AND (`!entry.superseded_by` OR the successor's `valid_from > asOf`). Successor lookup requires a map — build once at the top.
  - Else if `!includeSuperseded`: filter out entries where `entry.superseded_by !== null`.

In `search.ts markRetrieved`:
- Early return on entries with `superseded_by !== null`.

In `consolidate.ts detectConflicts`:
- Skip pairs where `survivors[i].superseded_by || survivors[j].superseded_by`.

In `cli.ts`:
- `cmdRecall`, `cmdContext`, `cmdExplain`: parse `--include-superseded` (boolean), `--as-of <iso-date>`. Pass through to search options.
- Recall output: when `--include-superseded` fires and an entry is superseded, prefix with `[superseded]` marker.

**Step 3: Pass → commit**

```bash
git add src/search.ts src/cli.ts src/consolidate.ts tests/bi-temporal-recall.test.ts
git commit -m "feat(bi-temporal): default-current recall + --include-superseded + --as-of"
```

---

## Task 4: Full suite, manual smoke, release prep

```bash
npm run build && npx vitest run
```

Expected: ~640 tests green (625 existing + ~15 new).

**Manual smoke** (fresh temp HIPPO_HOME):

```bash
export HIPPO_HOME=/tmp/hippo-bt-smoke/.hippo && rm -rf "$HIPPO_HOME"
hippo init
hippo remember "database is Postgres"      # -> id A
hippo recall "database"                      # finds A
hippo supersede <A> "database migrated to MySQL last week"
hippo recall "database"                      # finds new only
hippo recall "database" --include-superseded # finds both, old marked [superseded]
hippo recall "database" --as-of 2026-04-01  # finds A (if created before then)
```

---

## Done criteria

- [ ] Schema v11 applies to fresh stores AND existing v10 stores without data loss
- [ ] `hippo supersede` creates new memory, links old, prevents cycles
- [ ] Default recall hides superseded
- [ ] `--include-superseded` and `--as-of` work as specified
- [ ] `markRetrieved` is no-op for superseded
- [ ] `detectConflicts` skips superseded pairs
- [ ] Full suite green
- [ ] 3 commits (one per task)

## Do NOT

- Touch trace, scope, pinned-inject, replay, physics, embeddings.
- Backfill `valid_from` to anything other than `created` for existing rows.
- Add `valid_to` column (derived, not stored).
- Add UI to supersede chains (no "walk the chain" command yet; users see the link via `--include-superseded`).
- Break existing `hippo recall` behavior for stores with no superseded memories.
