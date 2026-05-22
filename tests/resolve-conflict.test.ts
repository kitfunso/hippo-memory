/**
 * Tests for conflict resolution: hippo resolve <id> --keep <memory_id>
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory } from '../src/memory.js';
import {
  initStore,
  writeEntry,
  readEntry,
  listMemoryConflicts,
  replaceDetectedConflicts,
  resolveConflict,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-resolve-'));
  initStore(tmpDir);
});

afterAll(() => {
  // Clean up any leftover temp dirs
});

function seedConflict(): { aId: string; bId: string; conflictId: number } {
  const a = createMemory('Always use semicolons in PowerShell', { tags: ['powershell', 'windows'] });
  const b = createMemory('Use && to chain commands in PowerShell', { tags: ['powershell', 'windows'] });
  writeEntry(tmpDir, a);
  writeEntry(tmpDir, b);

  replaceDetectedConflicts(tmpDir, [{
    memory_a_id: a.id,
    memory_b_id: b.id,
    reason: 'Contradictory advice about PowerShell chaining operators',
    score: 0.85,
  }]);

  const conflicts = listMemoryConflicts(tmpDir, 'open');
  expect(conflicts.length).toBe(1);

  return { aId: a.id, bId: b.id, conflictId: conflicts[0].id };
}

describe('resolveConflict', () => {
  it('resolves conflict and weakens the loser (default)', () => {
    const { aId, bId, conflictId } = seedConflict();

    const before = readEntry(tmpDir, bId)!;
    const result = resolveConflict(tmpDir, conflictId, aId);

    expect(result).not.toBeNull();
    expect(result!.loserId).toBe(bId);
    expect(result!.conflict.status).toBe('resolved');

    // Loser's half-life should be halved
    const after = readEntry(tmpDir, bId)!;
    expect(after.half_life_days).toBe(Math.max(1, before.half_life_days / 2));

    // Conflict should be resolved
    const openConflicts = listMemoryConflicts(tmpDir, 'open');
    expect(openConflicts.length).toBe(0);

    const resolvedConflicts = listMemoryConflicts(tmpDir, 'resolved');
    expect(resolvedConflicts.length).toBe(1);
  });

  it('resolves conflict and deletes loser when --forget is set', () => {
    const { aId, bId, conflictId } = seedConflict();

    const result = resolveConflict(tmpDir, conflictId, aId, true);

    expect(result).not.toBeNull();
    expect(result!.loserId).toBe(bId);

    // Loser should be deleted
    const deleted = readEntry(tmpDir, bId);
    expect(deleted).toBeNull();

    // Winner should still exist
    const winner = readEntry(tmpDir, aId);
    expect(winner).not.toBeNull();
  });

  it('cleans up conflicts_with references on both memories', () => {
    const { aId, bId, conflictId } = seedConflict();

    // Before resolve, both should have conflicts_with set
    const aBefore = readEntry(tmpDir, aId)!;
    expect(aBefore.conflicts_with).toContain(bId);

    resolveConflict(tmpDir, conflictId, aId);

    // After resolve, winner should not reference the loser
    const aAfter = readEntry(tmpDir, aId)!;
    expect(aAfter.conflicts_with).not.toContain(bId);
  });

  it('returns null for non-existent conflict ID', () => {
    seedConflict();
    const result = resolveConflict(tmpDir, 999, 'mem_doesnt_exist');
    expect(result).toBeNull();
  });

  it('returns null for already-resolved conflict', () => {
    const { aId, conflictId } = seedConflict();

    // Resolve once
    resolveConflict(tmpDir, conflictId, aId);

    // Try to resolve again
    const result = resolveConflict(tmpDir, conflictId, aId);
    expect(result).toBeNull();
  });

  it('returns null when --keep ID is not part of the conflict', () => {
    const { conflictId } = seedConflict();
    const result = resolveConflict(tmpDir, conflictId, 'mem_unrelated');
    expect(result).toBeNull();
  });

  it('works when keeping memory B instead of A', () => {
    const { aId, bId, conflictId } = seedConflict();

    const result = resolveConflict(tmpDir, conflictId, bId);

    expect(result).not.toBeNull();
    expect(result!.loserId).toBe(aId);

    // A should be weakened
    const aAfter = readEntry(tmpDir, aId)!;
    expect(aAfter.half_life_days).toBeLessThan(7); // default is 7
  });
});

describe('conflict tenant isolation (E2)', () => {
  function seedTenantConflict(tenant: string): { aId: string; bId: string; conflictId: number } {
    const a = createMemory(`semicolons rule for ${tenant}`, { tenantId: tenant, tags: ['x'] });
    const b = createMemory(`chaining rule for ${tenant}`, { tenantId: tenant, tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [{
      memory_a_id: a.id,
      memory_b_id: b.id,
      reason: `contradictory advice for ${tenant}`,
      score: 0.8,
    }]);
    const open = listMemoryConflicts(tmpDir, 'open', tenant);
    expect(open.length).toBe(1);
    return { aId: a.id, bId: b.id, conflictId: open[0].id };
  }

  it('listMemoryConflicts with tenantId returns only that tenant; omitted returns all', () => {
    // Both tenants' conflicts must be seeded in ONE replaceDetectedConflicts
    // call — it is a global replace and resolves any open conflict absent
    // from the detected set.
    const a1 = createMemory('tenant-a rule one', { tenantId: 'tenant-a', tags: ['x'] });
    const a2 = createMemory('tenant-a rule two', { tenantId: 'tenant-a', tags: ['x'] });
    const b1 = createMemory('tenant-b rule one', { tenantId: 'tenant-b', tags: ['x'] });
    const b2 = createMemory('tenant-b rule two', { tenantId: 'tenant-b', tags: ['x'] });
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

  it('resolveConflict with a non-owning tenantId returns null and leaves the conflict open', () => {
    const { aId, conflictId } = seedTenantConflict('tenant-a');

    const result = resolveConflict(tmpDir, conflictId, aId, false, 'tenant-b');
    expect(result).toBeNull();

    // The conflict is untouched — still open for its real owner.
    expect(listMemoryConflicts(tmpDir, 'open', 'tenant-a').length).toBe(1);
  });

  it('auto-resolves an existing open cross-tenant row when the pair is re-detected (v1.11.0 residue)', () => {
    // Seed two memories under different tenants.
    const a = createMemory('tenant-a content', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory('tenant-b content', { tenantId: 'tenant-b', tags: ['x'] });
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
    expect(listMemoryConflicts(tmpDir, 'open').find((c) => c.memory_a_id === memA && c.memory_b_id === memB)).toBeDefined();

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
    expect(ours).toBeDefined();
    expect(ours!.updated_at).toBe('2026-05-22T12:00:00.000Z');

    // No open cross-tenant row remains.
    expect(
      listMemoryConflicts(tmpDir, 'open').find((c) => c.memory_a_id === memA && c.memory_b_id === memB),
    ).toBeUndefined();
  });

  it('resolveConflict --forget with a foreign tenantId cannot delete the loser memory', () => {
    const { aId, bId, conflictId } = seedTenantConflict('tenant-a');

    const result = resolveConflict(tmpDir, conflictId, aId, true, 'tenant-b');
    expect(result).toBeNull();

    // The cross-tenant DELETE never fires — both memories survive.
    expect(readEntry(tmpDir, aId)).not.toBeNull();
    expect(readEntry(tmpDir, bId)).not.toBeNull();
  });

  it('resolveConflict with the owning tenantId still resolves normally', () => {
    const { aId, conflictId } = seedTenantConflict('tenant-a');

    const result = resolveConflict(tmpDir, conflictId, aId, false, 'tenant-a');
    expect(result).not.toBeNull();
    expect(result!.conflict.status).toBe('resolved');
    expect(listMemoryConflicts(tmpDir, 'resolved', 'tenant-a').length).toBe(1);
  });

  it('replaceDetectedConflicts skips a cross-tenant pair, keeps a within-tenant pair', () => {
    const a = createMemory('tenant-a memory one', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory('tenant-b memory one', { tenantId: 'tenant-b', tags: ['x'] });
    const c = createMemory('tenant-a memory two', { tenantId: 'tenant-a', tags: ['x'] });
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
    const a = createMemory('stale-row memory a', { tenantId: 'tenant-a', tags: ['x'] });
    const b = createMemory('stale-row memory b', { tenantId: 'tenant-a', tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'same-tenant at first', score: 0.8 },
    ]);
    expect(readEntry(tmpDir, a.id)!.conflicts_with).toContain(b.id);

    // Re-home b to tenant-b — the (a, b) conflict row is now cross-tenant.
    writeEntry(tmpDir, { ...b, tenantId: 'tenant-b' });

    // Re-run detection passing the same pair, so the row stays open and the
    // refMap rebuild — not the resolve-stale path — is what must exclude it.
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'now cross-tenant', score: 0.8 },
    ]);

    // a's conflicts_with must no longer carry b's id.
    expect(readEntry(tmpDir, a.id)!.conflicts_with).not.toContain(b.id);
  });
});
