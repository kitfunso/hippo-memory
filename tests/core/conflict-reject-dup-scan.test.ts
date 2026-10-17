// Rejecting a conflict loser's value streams the tenant's rows instead of holding them all, and removes the same duplicates.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { MemoryEntry } from '../../src/core/memory.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { readEntry } from '../../src/store/entry-reads.js';
import { listMemoryConflicts, replaceDetectedConflicts, resolveConflict } from '../../src/store/conflicts.js';
import { queryAuditEvents } from '../../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

interface StatementProto { readonly sourceSQL: string; all(...params: unknown[]): unknown[] }
const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; all() takes SQL params and returns the row array.
const { StatementSync } = require('node:sqlite') as { StatementSync: { prototype: StatementProto } };

/** The duplicate scan: every other row of the loser's tenant. */
const DUP_SCAN = 'SELECT id, kind, content, scope FROM memories WHERE tenant_id = ?';
const LOSER = 'Use && to chain commands in PowerShell';

let root: string;

beforeEach(() => {
  root = makeRoot('reject-dup-scan');
});

interface ArrayReads<T> {
  result: T;
  sql: string[];
}

interface RejectedLoser {
  keepId: string;
  loserId: string;
  resolve: () => ReturnType<typeof resolveConflict>;
}

/** SQL of every statement whose rows `fn` took as one array. */
function arrayReads<T>(fn: () => T): ArrayReads<T> {
  const sql: string[] = [];
  const all = StatementSync.prototype.all;
  const spy = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementProto, ...params: unknown[]) {
    sql.push(this.sourceSQL);
    return all.apply(this, params);
  });
  try {
    return { result: fn(), sql };
  } finally {
    spy.mockRestore();
  }
}

function put(content: string, extra: Partial<MemoryEntry> = {}, tenantId = 'default'): string {
  const entry = { ...createMemory(content, { tags: ['x'], tenantId }), ...extra };
  writeEntry(root, entry);
  return entry.id;
}

function rejectLoser(): RejectedLoser {
  const keepId = put('Always use semicolons in PowerShell');
  const loserId = put(LOSER);
  replaceDetectedConflicts(root, [{ memory_a_id: keepId, memory_b_id: loserId, reason: 'contradictory chaining advice', score: 0.85 }]);
  const conflictId = listMemoryConflicts(root, 'open')[0]!.id;
  const resolve = () => resolveConflict(root, { conflictId, keepId, tenantId: 'default' }, { rejectLoserValue: true, reason: 'wrong' });
  return { keepId, loserId, resolve };
}

function removedIds(): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: conflict_resolve audit rows always carry removedIds as string[].
    return queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' })[0]!.metadata.removedIds as string[];
  } finally {
    closeHippoDb(db);
  }
}

/** Ids moved to raw_archive: an archived raw row leaves the memories table. */
function archivedRawIds(): string[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: one TEXT memory_id column.
    return (db.prepare('SELECT memory_id FROM raw_archive ORDER BY memory_id').all() as Array<{ memory_id: string }>).map((r) => r.memory_id);
  } finally {
    closeHippoDb(db);
  }
}

describe('rejecting a conflict loser value', () => {
  it('removes the same duplicates: case and spacing variants and raw rows, never another owner\'s or tenant\'s', () => {
    const { keepId, loserId, resolve } = rejectLoser();
    const spaced = put(`  use &&   TO chain commands\tin powershell `);
    const raw = put(LOSER, { kind: 'raw' });
    const personal = put(LOSER, { scope: 'personal:private:bob', owner: 'bob' });
    const otherTenant = put(LOSER, {}, 'other');
    const unrelated = put('Use ; to chain commands in PowerShell');
    expect(resolve()).not.toBeNull();
    expect(removedIds().slice().sort()).toEqual([loserId, spaced, raw].sort());
    expect(readEntry(root, spaced)).toBeNull();
    expect(readEntry(root, raw)).toBeNull();
    expect(archivedRawIds()).toEqual([raw]);
    expect(readEntry(root, personal)).not.toBeNull();
    expect(readEntry(root, otherTenant, 'other')).not.toBeNull();
    expect(readEntry(root, unrelated)).not.toBeNull();
    expect(readEntry(root, keepId)).not.toBeNull();
  });

  it('never holds every row of the tenant at once', () => {
    const { resolve } = rejectLoser();
    for (let i = 0; i < 20; i++) put(`unrelated note number ${i}`);
    const { result, sql } = arrayReads(resolve);
    expect(result).not.toBeNull();
    expect(sql.filter((s) => s.includes(DUP_SCAN))).toEqual([]);
  });
});
