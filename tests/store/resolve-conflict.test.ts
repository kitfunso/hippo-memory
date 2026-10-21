/**
 * Tests for conflict resolution: hippo resolve <id> --keep <memory_id>
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { conflictResolve } from '../../src/api/index.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../src/base/errors/api-errors.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { replaceDetectedConflicts, listMemoryConflicts, writeEntry, readEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Parameters<typeof createMemory>[1] = {}) =>
  createMemory(content, { baseHalfLifeDays: 7, ...options });

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('resolve');
});

afterAll(() => {
  // Clean up any leftover temp dirs
});

function seedConflict() {
  const a = createMemory7('Always use semicolons in PowerShell', { tags: ['powershell', 'windows'] });
  const b = createMemory7('Use && to chain commands in PowerShell', { tags: ['powershell', 'windows'] });
  writeEntry(tmpDir, a);
  writeEntry(tmpDir, b);

  replaceDetectedConflicts(tmpDir, [
    {
      memory_a_id: a.id,
      memory_b_id: b.id,
      reason: 'Contradictory advice about PowerShell chaining operators',
      score: 0.85,
    },
  ]);

  const conflicts = listMemoryConflicts(tmpDir, 'open');
  expect(conflicts.length).toBe(1);

  return { aId: a.id, bId: b.id, conflictId: conflicts[0].id };
}

const resolve = (conflictId: number, keepId: string, opts: { forget?: boolean; tenantId?: string } = {}) =>
  conflictResolve(apiCtx(tmpDir, opts.tenantId ?? 'default'), conflictId, { keepId, forget: opts.forget });

describe('resolveConflict', () => {
  it('resolves conflict and weakens the loser (default)', async () => {
    const { aId, bId, conflictId } = seedConflict();

    const before = readEntry(tmpDir, bId)!;
    const result = await resolve(conflictId, aId);
    expect(result.loserId).toBe(bId);

    // Loser's half-life should be halved
    const after = readEntry(tmpDir, bId)!;
    expect(after.halfLifeDays).toBe(Math.max(1, before.halfLifeDays / 2));

    // Conflict should be resolved
    const openConflicts = listMemoryConflicts(tmpDir, 'open');
    expect(openConflicts.length).toBe(0);

    const resolvedConflicts = listMemoryConflicts(tmpDir, 'resolved');
    expect(resolvedConflicts.length).toBe(1);
  });

  it('resolves conflict and deletes loser when --forget is set', async () => {
    const { aId, bId, conflictId } = seedConflict();

    expect((await resolve(conflictId, aId, { forget: true })).loserId).toBe(bId);

    // Loser should be deleted
    const deleted = readEntry(tmpDir, bId);
    expect(deleted).toBeNull();

    // Winner should still exist
    const winner = readEntry(tmpDir, aId);
    expect(winner).not.toBeNull();
  });

  it('cleans up conflicts_with references on both memories', async () => {
    const { aId, bId, conflictId } = seedConflict();

    // Before resolve, both should have conflicts_with set
    const aBefore = readEntry(tmpDir, aId)!;
    expect(aBefore.conflictsWith).toContain(bId);

    await resolve(conflictId, aId);

    // After resolve, winner should not reference the loser
    const aAfter = readEntry(tmpDir, aId)!;
    expect(aAfter.conflictsWith).not.toContain(bId);
  });

  it('still cleans the other side when a side has malformed conflicts_with_json', async () => {
    const { aId, bId, conflictId } = seedConflict();
    const db = openHippoDb(tmpDir);
    try {
      db.prepare(`UPDATE memories SET conflicts_with_json = '{not json' WHERE id = ?`).run(aId);
    } finally {
      closeHippoDb(db);
    }

    await expect(resolve(conflictId, aId)).resolves.toEqual({ conflictId, keptId: aId, loserId: bId });

    expect(readEntry(tmpDir, bId)!.conflictsWith).not.toContain(aId);
    expect(readEntry(tmpDir, aId)!.conflictsWith).toEqual([]);
  });

  it('answers not-found for an unknown conflict id from one read by id, with no list read', async () => {
    seedConflict();
    const { result, statements } = await recordStatementsAsync(() =>
      resolve(999, 'mem_doesnt_exist').catch((err: Error) => err),
    );
    expect(result).toBeInstanceOf(NotFoundError);
    const reads = statements.filter((sql) => sql.includes('FROM memory_conflicts'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('mc.id = ?');
    expect(reads[0]).not.toContain('ORDER BY');
  });

  it('writes nothing when a side no longer holds the scope the api decided on', () => {
    const { aId, bId, conflictId } = seedConflict();
    const resolved = sqliteSyncStore(tmpDir).conflicts.resolve('default', {
      conflictId,
      keep: { id: aId, scope: null },
      loser: { id: bId, scope: 'personal:private:moved' },
      fate: { kind: 'remove' },
      actor: 'cli',
      reason: 'scope moved',
    });
    expect(resolved).toBe(false);
    expect(readEntry(tmpDir, bId)).not.toBeNull();
    expect(listMemoryConflicts(tmpDir, 'open')).toHaveLength(1);
  });

  it("a reject fate removes the value's copies its ownScope may touch, in the same write, and keeps another person's", () => {
    const { aId, bId, conflictId } = seedConflict();
    const copyOf = (scope: string, owner: string | null = null) => {
      const copy = { ...createMemory7('Use && to chain commands in PowerShell', { tags: ['x'] }), scope, owner };
      writeEntry(tmpDir, copy);
      return copy.id;
    };
    const team = copyOf('team:shared');
    const mine = copyOf('personal:private:alice', 'alice');
    const theirs = copyOf('personal:private:bob', 'bob');
    const resolved = sqliteSyncStore(tmpDir).conflicts.resolve('default', {
      conflictId,
      keep: { id: aId, scope: null },
      loser: { id: bId, scope: null },
      fate: { kind: 'reject', ownScope: 'personal:private:alice' },
      actor: 'cli',
      reason: 'wrong',
    });
    expect(resolved).toBe(true);
    expect([bId, team, mine].map((id) => readEntry(tmpDir, id))).toEqual([null, null, null]);
    expect(readEntry(tmpDir, theirs)).not.toBeNull();
    expect(readEntry(tmpDir, aId)).not.toBeNull();
  });

  it('a reject fate with no ownScope keeps every personal copy', () => {
    const { aId, bId, conflictId } = seedConflict();
    const personal = {
      ...createMemory7('Use && to chain commands in PowerShell', { tags: ['x'] }),
      scope: 'personal:private:alice',
      owner: 'alice',
    };
    writeEntry(tmpDir, personal);
    const fate = { kind: 'reject', ownScope: null } as const;
    const resolution = {
      conflictId,
      keep: { id: aId, scope: null },
      loser: { id: bId, scope: null },
      fate,
      actor: 'cli',
      reason: 'wrong',
    };
    expect(sqliteSyncStore(tmpDir).conflicts.resolve('default', resolution)).toBe(true);
    expect(readEntry(tmpDir, bId)).toBeNull();
    expect(readEntry(tmpDir, personal.id)).not.toBeNull();
  });

  it('answers 409 for an already-resolved conflict', async () => {
    const { aId, conflictId } = seedConflict();
    await resolve(conflictId, aId);
    await expect(resolve(conflictId, aId)).rejects.toBeInstanceOf(ConflictError);
  });

  it('answers 400 when --keep ID is not part of the conflict', async () => {
    const { conflictId } = seedConflict();
    await expect(resolve(conflictId, 'mem_unrelated')).rejects.toBeInstanceOf(BadRequestError);
    expect(listMemoryConflicts(tmpDir, 'open')).toHaveLength(1);
  });

  it('works when keeping memory B instead of A', async () => {
    const { aId, bId, conflictId } = seedConflict();

    expect((await resolve(conflictId, bId)).loserId).toBe(aId);

    // A should be weakened
    const aAfter = readEntry(tmpDir, aId)!;
    expect(aAfter.halfLifeDays).toBeLessThan(7); // default is 7
  });
});

describe('conflict tenant isolation', () => {
  function seedTenantConflict(tenant: string) {
    const a = createMemory7(`semicolons rule for ${tenant}`, { tenantId: tenant, tags: ['x'] });
    const b = createMemory7(`chaining rule for ${tenant}`, { tenantId: tenant, tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      {
        memory_a_id: a.id,
        memory_b_id: b.id,
        reason: `contradictory advice for ${tenant}`,
        score: 0.8,
      },
    ]);
    const open = listMemoryConflicts(tmpDir, 'open', tenant);
    expect(open.length).toBe(1);
    return { aId: a.id, bId: b.id, conflictId: open[0].id };
  }

  it('listMemoryConflicts with tenantId returns only that tenant; omitted returns all', () => {
    // Both tenants' conflicts must be seeded in ONE replaceDetectedConflicts
    // call — it is a global replace and resolves any open conflict absent
    // from the detected set.
    const a1 = createMemory7('tenant-a rule one', { tenantId: 'tenant-a', tags: ['x'] });
    const a2 = createMemory7('tenant-a rule two', { tenantId: 'tenant-a', tags: ['x'] });
    const b1 = createMemory7('tenant-b rule one', { tenantId: 'tenant-b', tags: ['x'] });
    const b2 = createMemory7('tenant-b rule two', { tenantId: 'tenant-b', tags: ['x'] });
    for (const m of [a1, a2, b1, b2]) writeEntry(tmpDir, m);

    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a1.id, memory_b_id: a2.id, reason: 'tenant-a conflict', score: 0.8 },
      { memory_a_id: b1.id, memory_b_id: b2.id, reason: 'tenant-b conflict', score: 0.8 },
    ]);

    expect(listMemoryConflicts(tmpDir, 'open', 'tenant-a').length).toBe(1);
    expect(listMemoryConflicts(tmpDir, 'open', 'tenant-b').length).toBe(1);
    // Omitted tenantId = legacy unscoped behaviour: every tenant's conflicts.
    expect(listMemoryConflicts(tmpDir, 'open').length).toBe(2);
  });

  it('resolveConflict with a non-owning tenantId answers not-found and leaves the conflict open', async () => {
    const { aId, conflictId } = seedTenantConflict('tenant-a');

    await expect(resolve(conflictId, aId, { tenantId: 'tenant-b' })).rejects.toBeInstanceOf(NotFoundError);

    // The conflict is untouched — still open for its real owner.
    expect(listMemoryConflicts(tmpDir, 'open', 'tenant-a').length).toBe(1);
  });

  it('auto-resolves an existing open cross-tenant row when the pair is re-detected', () => {
    // Seed two memories under different tenants.
    const a = createMemory7('tenant-a content', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory7('tenant-b content', { tenantId: 'tenant-b', tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    const [memA, memB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

    // Manually insert a pre-fix open cross-tenant conflict row (the kind that
    // could exist from before E2's tenant guard).
    const db = openHippoDb(tmpDir);
    try {
      db.prepare(
        `INSERT INTO memory_conflicts ` +
          `(memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at) ` +
          `VALUES (?, ?, ?, ?, 'open', '2026-01-01', '2026-01-01')`,
      ).run(memA, memB, 'pre-fix cross-tenant', 0.9);
    } finally {
      closeHippoDb(db);
    }
    expect(
      listMemoryConflicts(tmpDir, 'open').find((c) => c.memory_a_id === memA && c.memory_b_id === memB)?.reason,
    ).toBe('pre-fix cross-tenant');

    // Simulate an unscoped detector re-detecting the cross-tenant pair. Before
    // the fix, the resolve-stale loop saw the key in detectedKeys and skipped
    // resolution; the insert loop skipped re-inserting (cross-tenant); the
    // refMap rebuild skipped it. The row lingered status='open' forever.
    replaceDetectedConflicts(
      tmpDir,
      [{ memory_a_id: a.id, memory_b_id: b.id, reason: 're-detected cross-tenant', score: 0.9 }],
      '2026-05-22T12:00:00.000Z',
    );

    // The cross-tenant row is now resolved.
    const resolved = listMemoryConflicts(tmpDir, 'resolved');
    const ours = resolved.find((c) => c.memory_a_id === memA && c.memory_b_id === memB);
    expect(ours?.updated_at).toBe('2026-05-22T12:00:00.000Z');

    // No open cross-tenant row remains.
    expect(
      listMemoryConflicts(tmpDir, 'open').find((c) => c.memory_a_id === memA && c.memory_b_id === memB),
    ).toBeUndefined();
  });

  it('resolveConflict --forget with a foreign tenantId cannot delete the loser memory', async () => {
    const { aId, bId, conflictId } = seedTenantConflict('tenant-a');

    await expect(resolve(conflictId, aId, { forget: true, tenantId: 'tenant-b' })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The cross-tenant DELETE never fires — both memories survive.
    expect(readEntry(tmpDir, aId)).not.toBeNull();
    expect(readEntry(tmpDir, bId)).not.toBeNull();
  });

  it('resolveConflict with the owning tenantId still resolves normally', async () => {
    const { aId, conflictId } = seedTenantConflict('tenant-a');

    await expect(resolve(conflictId, aId, { tenantId: 'tenant-a' })).resolves.toMatchObject({ conflictId });
    expect(listMemoryConflicts(tmpDir, 'resolved', 'tenant-a').length).toBe(1);
  });

  it('replaceDetectedConflicts skips a cross-tenant pair, keeps a within-tenant pair', () => {
    const a = createMemory7('tenant-a memory one', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory7('tenant-b memory one', { tenantId: 'tenant-b', tags: ['x'] });
    const c = createMemory7('tenant-a memory two', { tenantId: 'tenant-a', tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    writeEntry(tmpDir, c);

    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'cross-tenant', score: 0.9 },
      { memory_a_id: a.id, memory_b_id: c.id, reason: 'within-tenant', score: 0.9 },
    ]);

    // Only the within-tenant (a, c) conflict is persisted.
    expect(listMemoryConflicts(tmpDir, 'open').length).toBe(1);
    expect(listMemoryConflicts(tmpDir, 'open', 'tenant-a').length).toBe(1);
  });

  it('replaceDetectedConflicts does not seed a foreign id into conflicts_with for a stale cross-tenant row', () => {
    // Seed a within-tenant conflict, then re-home one member to another tenant
    // so the existing conflict row becomes cross-tenant — simulating a row
    // persisted before this fix.
    const a = createMemory7('stale-row memory a', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory7('stale-row memory b', { tenantId: 'tenant-a', tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'same-tenant at first', score: 0.8 },
    ]);
    expect(readEntry(tmpDir, a.id)!.conflictsWith).toContain(b.id);

    // Re-home b to tenant-b — the (a, b) conflict row is now cross-tenant.
    writeEntry(tmpDir, { ...b, tenantId: 'tenant-b' });

    // Re-run detection passing the same pair, so the row stays open and the
    // refMap rebuild — not the resolve-stale path — is what must exclude it.
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'now cross-tenant', score: 0.8 },
    ]);

    // a's conflicts_with must no longer carry b's id.
    expect(readEntry(tmpDir, a.id)!.conflictsWith).not.toContain(b.id);
  });
});
