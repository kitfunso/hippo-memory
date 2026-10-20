// Outcome writes rows, audit rows and mirror marks in set statements, and the mirrors after: pinned against the per-id
// path it replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  CHURN_STALE_TAG,
  DAG_LEVEL,
  DEFAULT_HALF_LIFE_DAYS,
  Layer,
  createMemory,
  entryAfterOutcome,
  type MemoryEntry,
} from '../../src/base/memory/memory.js';
import { ownScopeTouches } from '../../src/base/scope/recall-scope.js';
import { writeEntriesTogetherAt, writeEntryDbOnly, writeEntryMirrorsIn } from '../../src/store/sqlite/entry-writes.js';
import { selectEntriesByIds } from '../../src/store/sqlite/entry-reads.js';
import { appendAuditEvent } from '../../src/store/sqlite/audit.js';
import { applyOutcomeAt, auditingRefusal } from '../../src/store/sqlite/entry-writes.js';
import type { OutcomeWrite } from '../../src/store/port/entry-writes.js';
import { openStore } from '../../src/store/sqlite/handles.js';
import { flushHeldMirrors } from '../../src/store/sqlite/mirrors.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace];
const open: DatabaseSyncLike[] = [];

beforeEach(() => {
  // strength decays with the clock and audit rows stamp it, so both paths read one fixed time.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of open.splice(0)) closeHippoDb(db);
});

/** The per-id path outcome ran before the set rewrite, kept as the reference the new path must match. */
function applyOutcomePerId(db: DatabaseSyncLike, root: string, outcome: OutcomeWrite): string[] {
  const applied = auditingRefusal(db, outcome.actor, () =>
    withWriteScope(db, 'apply_outcome', () => {
      const live = selectEntriesByIds(db, outcome.ids, outcome.tenantId);
      const out: MemoryEntry[] = [];
      for (const id of outcome.ids) {
        const entry = live.get(id);
        if (!entry || !ownScopeTouches(outcome.ownScope, entry.scope)) continue;
        const updated = entryAfterOutcome(entry, outcome.good);
        writeEntryDbOnly(db, updated, { actor: outcome.actor });
        live.set(id, updated);
        appendAuditEvent(db, {
          tenantId: outcome.tenantId,
          actor: outcome.actor,
          op: 'outcome',
          targetId: id,
          metadata: { good: outcome.good },
        });
        out.push(updated);
      }
      return out;
    }),
  );
  for (const entry of applied) writeEntryMirrorsIn({ hippoRoot: root }, entry);
  return applied.map((entry) => entry.id);
}

function memory(i: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const content = `outcome pin row ${i} about the zephyrine cache`;
  const base = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  return { ...base, originProject: 'pin-project', ...extra };
}

/** Summary parents (one already dirty), churn-stale tags, three layers, an out-of-reach personal row, another tenant's
 * row, repeated ids and a missing one. */
function fixture(count: number) {
  const summaries = [0, 1, 2].map((i) => memory(10_000 + i, { dagLevel: DAG_LEVEL.topic, layer: Layer.Semantic }));
  const rows = Array.from({ length: count }, (_, i) =>
    memory(i, {
      tags: i % 7 === 0 ? ['alpha', CHURN_STALE_TAG] : ['alpha'],
      dagParentId: i % 10 === 0 ? summaries[i % 3]!.id : null,
      layer: [Layer.Buffer, Layer.Episodic, Layer.Semantic][i % 3]!,
      scope: i % 50 === 1 ? 'personal:private:someone-else' : null,
      outcomePositive: i % 4,
      outcomeNegative: i % 3,
    }),
  );
  const foreign = memory(20_000, { tenantId: 'other' });
  const repeats = [rows[3]!.id, rows[3]!.id, rows[4]!.id];
  const ids = [...rows.map((row) => row.id), summaries[0]!.id, foreign.id, ...repeats, 'mem_missing'];
  return { entries: [...summaries, ...rows, foreign], ids };
}

function seeded(label: string, entries: readonly MemoryEntry[]) {
  const root = makeRoot(label);
  const db = openStore(root);
  open.push(db);
  writeEntriesTogetherAt(db, { hippoRoot: root }, entries);
  // The seed's own child writes marked every parent; clear all but one so the outcome has flips to make.
  db.prepare('UPDATE memories SET summary_dirty = (id = ?)').run(entries[2]!.id);
  // A stale copy in another layer, which every mirror write removes.
  fs.copyFileSync(
    path.join(root, entries[3]!.layer, `${entries[3]!.id}.md`),
    path.join(root, Layer.Semantic, `${entries[3]!.id}.md`),
  );
  return { root, db };
}

function mirrorFiles(root: string) {
  const files = new Map<string, string>();
  for (const layer of LAYERS) {
    const dir = path.join(root, layer);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      files.set(`${layer}/${name}`, fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return files;
}

interface AuditRow {
  id: number;
  ts: string;
  tenant_id: string;
  actor: string;
  op: string;
  target_id: string | null;
}
interface FtsRow {
  id: string;
  content: string;
  tags: string;
}

/** Every stored value outcome can touch, with each column's storage class; updated_at is SQLite's own clock. */
function snapshot(root: string, db: DatabaseSyncLike) {
  // SAFETY: PRAGMA table_info answers one row per column, its name in `name`.
  const columns = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((name) => name !== 'updated_at');
  const types = columns.map((c) => `typeof(${c})`).join(', ');
  return {
    memories: db.prepare(`SELECT ${columns.join(', ')} FROM memories ORDER BY id`).all(),
    storage: db.prepare(`SELECT ${types} FROM memories ORDER BY id`).all(),
    // SAFETY: SELECT * over audit_log answers the AuditRow columns and metadata_json.
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[],
    // SAFETY: the three columns named.
    fts: db.prepare('SELECT id, content, tags FROM memories_fts ORDER BY id').all() as FtsRow[],
    mirrors: mirrorFiles(root),
  };
}

function outcomeOf(ids: readonly string[], good: boolean): OutcomeWrite {
  return { tenantId: 'default', actor: 'test:pin', ownScope: null, ids, good };
}

describe('outcome over 200 ids', () => {
  it.each([true, false])('writes the rows, audit, full-text and mirrors the per-id path wrote (good=%s)', (good) => {
    const { entries, ids } = fixture(200);
    const before = seeded('outcome-pin-old', entries);
    const after = seeded('outcome-pin-new', entries);
    const expected = applyOutcomePerId(before.db, before.root, outcomeOf(ids, good));
    const got = applyOutcomeAt(after.db, { hippoRoot: after.root }, outcomeOf(ids, good));
    flushHeldMirrors(after.root);
    expect(got).toEqual(expected);
    expect(got.length).toBeGreaterThan(190);
    const want = snapshot(before.root, before.db);
    // The fixture reaches every branch: two summaries flip dirty, and a good outcome re-indexes churn-stale rows.
    expect(want.audit.filter((row) => row.op === 'summary_marked_dirty' && row.actor === 'test:pin')).toHaveLength(2);
    expect(want.fts.some((row) => row.tags.includes(CHURN_STALE_TAG))).toBe(!good);
    expect(snapshot(after.root, after.db)).toEqual(want);
  });
});

describe('outcome statement count', () => {
  it('runs the same statements over 10 ids as over 200', () => {
    const counts = [10, 200].map((n) => {
      const { entries } = fixture(n);
      const ids = entries.filter((e) => e.tenantId === 'default' && e.scope === null).map((e) => e.id);
      const { root, db } = seeded(`outcome-count-${n}`, entries);
      const { statements } = recordStatements(() => applyOutcomeAt(db, { hippoRoot: root }, outcomeOf(ids, false)));
      return statements.length;
    });
    expect(counts[0]).toBe(counts[1]);
    // One of them marks the mirrors due, in place of a file write per row on the job's path.
    expect(counts[0]).toBeLessThanOrEqual(7);
  });
});

describe('outcome that fails mid-batch', () => {
  // 900 rows span two UPDATE chunks, so the failing last row sits in a later statement than the rest.
  function failingStore(trigger: (lastId: string) => string) {
    const entries = Array.from({ length: 900 }, (_, i) => memory(i));
    const root = makeRoot('outcome-fail');
    const db = openStore(root);
    open.push(db);
    withWriteScope(db, 'seed', () => {
      for (const entry of entries) writeEntryDbOnly(db, entry);
    });
    db.exec(trigger(entries.at(-1)!.id));
    return { root, db, ids: entries.map((e) => e.id) };
  }

  it.each([
    [
      'a row update',
      (id: string) =>
        `CREATE TRIGGER fail_row BEFORE UPDATE ON memories WHEN NEW.id = '${id}' ` +
        `BEGIN SELECT RAISE(ABORT, 'row refused'); END`,
    ],
    [
      'an audit row',
      (id: string) =>
        `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'outcome' ` +
        `AND NEW.target_id = '${id}' BEGIN SELECT RAISE(ABORT, 'audit refused'); END`,
    ],
  ])('leaves no row, audit row or mirror when %s fails', (_label, trigger) => {
    const { root, db, ids } = failingStore(trigger);
    const before = snapshot(root, db);
    expect(() => applyOutcomeAt(db, { hippoRoot: root }, outcomeOf(ids, true))).toThrow(/refused/);
    expect(snapshot(root, db)).toEqual(before);
  });
});
