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
