import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import * as api from '../../src/api/index.js';
import { RejectedValueError } from '../../src/base/errors/api-errors.js';
import { rejectionDigest, rowDigests, tombstoneDigest } from '../../src/base/records/rejection-digest.js';
import { listRejectionsForTenant } from '../../src/domain/trust/reject-flow.js';
import { makeRoot } from '../_helpers/make-root.js';
import { replaceDetectedConflicts, listMemoryConflicts, readEntry } from '../_helpers/root-forms.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore, apiCtx } = sessionPerTest();

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('reject-verbs');
});

function ctx(tenantId: string = 'default'): FullContext {
  return apiCtx(tmpDir, tenantId, { subject: 'cli', role: 'admin' });
}

describe('api.reject / api.unreject / listRejectionsForTenant', () => {
  it('reject by id removes the row + all same-digest duplicates, one reject_value audit, zero forget audits', async () => {
    const a = createMemory('duplicate offending value', { tags: ['x'] });
    const b = createMemory('DUPLICATE OFFENDING VALUE', { tags: ['y'] });
    const unrelated = createMemory('unrelated safe value', { tags: ['z'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    writeEntry(tmpDir, unrelated);

    const result = await api.reject(ctx(), { memoryId: a.id, reason: 'test rejection' });
    expect(result.removedIds.slice().sort()).toEqual([a.id, b.id].sort());

    expect(readEntry(tmpDir, a.id)).toBeNull();
    expect(readEntry(tmpDir, b.id)).toBeNull();
    expect(readEntry(tmpDir, unrelated.id)).not.toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const rejectEvents = listAuditEvents(db, { tenantId: 'default', op: 'reject_value' });
      expect(rejectEvents.length).toBe(1);
      expect(rejectEvents[0]!.metadata.digest).toBe(result.digest);
      expect(rejectEvents[0]!.metadata.count).toBe(2);

      const forgetEvents = listAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(forgetEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('reject purges the trace-layer markdown mirror', async () => {
    const trace = createMemory('trace: read config.ts -> rotated the deploy key -> success', {
      layer: Layer.Trace,
      traceOutcome: 'success',
    });
    writeEntry(tmpDir, trace);
    const mirrorPath = path.join(tmpDir, Layer.Trace, `${trace.id}.md`);
    expect(fs.existsSync(mirrorPath)).toBe(true);

    await api.reject(ctx(), { memoryId: trace.id, reason: 'trace content was wrong' });
    expect(readEntry(tmpDir, trace.id)).toBeNull();
    expect(fs.existsSync(mirrorPath)).toBe(false);
  });

  it('rejections lists the tombstone', async () => {
    const a = createMemory('to be rejected', { tags: [] });
    writeEntry(tmpDir, a);
    await api.reject(ctx(), { memoryId: a.id, reason: 'listed test' });

    const rows = await listRejectionsForTenant(sqliteStore(tmpDir), 'default');
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toBe('listed test');
    expect(rows[0]!.sourceMemoryId).toBe(a.id);
  });

  it('re-remember of the rejected value is refused', async () => {
    const a = createMemory('refuse me please', { tags: [] });
    writeEntry(tmpDir, a);
    await api.reject(ctx(), { memoryId: a.id, reason: 'refused' });

    await expect(api.remember(ctx(), { content: 'refuse me please' })).rejects.toThrow(RejectedValueError);
  });

  it('unreject then re-remember succeeds', async () => {
    const a = createMemory('temporarily rejected', { tags: [] });
    writeEntry(tmpDir, a);
    const rejectResult = await api.reject(ctx(), { memoryId: a.id, reason: 'temp' });

    const unrejectResult = await api.unreject(ctx(), rejectResult.digest);
    expect(unrejectResult.ok).toBe(true);
    expect((await listRejectionsForTenant(sqliteStore(tmpDir), 'default')).length).toBe(0);

    expect(await api.remember(ctx(), { content: 'temporarily rejected' })).toMatchObject({ id: expect.any(String) });
  });

  it('reject --value pre-emptive path: zero removals, still refuses a later write', async () => {
    const result = await api.reject(ctx(), { value: 'never seen before value', reason: 'pre-emptive' });
    expect(result.removedIds.length).toBe(0);

    await expect(api.remember(ctx(), { content: 'never seen before value' })).rejects.toThrow(RejectedValueError);
  });

  it('reject requires a non-empty reason', async () => {
    const a = createMemory('needs a reason', { tags: [] });
    writeEntry(tmpDir, a);
    await expect(api.reject(ctx(), { memoryId: a.id, reason: '' })).rejects.toThrow();
  });

  it('reject throws when both memoryId and value are given', async () => {
    const a = createMemory('both forms supplied at once', { tags: [] });
    writeEntry(tmpDir, a);
    await expect(
      api.reject(ctx(), { memoryId: a.id, value: 'a different value entirely', reason: 'ambiguous' }),
    ).rejects.toThrow();
  });

  it('unreject throws on a blank digest/prefix instead of matching every tombstone', async () => {
    const a = createMemory('to be rejected for the blank-unreject test', { tags: [] });
    writeEntry(tmpDir, a);
    await api.reject(ctx(), { memoryId: a.id, reason: 'setup for blank-unreject test' });
    expect((await listRejectionsForTenant(sqliteStore(tmpDir), 'default')).length).toBe(1);

    await expect(api.unreject(ctx(), '')).rejects.toThrow();
    await expect(api.unreject(ctx(), '   ')).rejects.toThrow();
    expect((await listRejectionsForTenant(sqliteStore(tmpDir), 'default')).length).toBe(1);
  });
});

describe('resolveConflict rejection wiring', () => {
  async function seedConflict() {
    const a = createMemory('Always use semicolons in PowerShell', { tags: ['x'] });
    const b = createMemory('Use && to chain commands in PowerShell', { tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      {
        memoryAId: a.id,
        memoryBId: b.id,
        reason: 'contradictory chaining advice',
        score: 0.85,
      },
    ]);
    const conflicts = await listMemoryConflicts(tmpDir, 'open');
    return { aId: a.id, bId: b.id, conflictId: conflicts[0]!.id };
  }

  it('a plain resolve writes a conflict_resolve audit with disposition=weakened', async () => {
    const { aId, bId, conflictId } = await seedConflict();
    expect(await api.conflictResolve(ctx(), conflictId, { keepId: aId })).toEqual({
      conflictId,
      keptId: aId,
      loserId: bId,
    });
    expect(await listMemoryConflicts(tmpDir, 'open')).toEqual([]);

    const db = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('weakened');
      expect(events[0]!.metadata.rejected).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('resolveConflict --forget writes a conflict_resolve audit with disposition=deleted', async () => {
    const { aId, bId, conflictId } = await seedConflict();
    await api.conflictResolve(ctx(), conflictId, { keepId: aId, forget: true });
    expect(readEntry(tmpDir, bId)).toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('deleted');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue tombstones + removes the loser; re-remember of its content is refused', async () => {
    const { aId, bId, conflictId } = await seedConflict();
    await api.conflictResolve(ctx(), conflictId, { keepId: aId, rejectLoser: true, reason: 'loser rejected' });
    expect(readEntry(tmpDir, bId)).toBeNull();

    await expect(api.remember(ctx(), { content: 'Use && to chain commands in PowerShell' })).rejects.toThrow(
      RejectedValueError,
    );

    const db = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.rejected).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue removes a same-tenant same-digest duplicate but leaves an identical-content row in ANOTHER tenant untouched', async () => {
    const { aId, bId, conflictId } = await seedConflict();
    const loserContent = 'Use && to chain commands in PowerShell';

    const dup = createMemory(loserContent, { tags: ['dup'] });
    writeEntry(tmpDir, dup);

    const otherTenantDup = createMemory(loserContent, { tags: ['dup'], tenantId: 'other-tenant' });
    writeEntry(tmpDir, otherTenantDup);

    await api.conflictResolve(ctx(), conflictId, {
      keepId: aId,
      rejectLoser: true,
      reason: 'loser + same-tenant duplicates rejected',
    });

    expect(readEntry(tmpDir, bId)).toBeNull();
    expect(readEntry(tmpDir, dup.id)).toBeNull();
    expect(readEntry(tmpDir, otherTenantDup.id, 'other-tenant')).not.toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      // SAFETY: resolveConflict's conflict_resolve audit always writes
      // metadata.removedIds as string[] (src/store/conflicts.ts's conflictResolveMeta).
      const removedIds = events[0]!.metadata.removedIds as string[];
      expect(removedIds.slice().sort()).toEqual([bId, dup.id].sort());
    } finally {
      closeHippoDb(db);
    }

    await expect(api.remember(ctx(), { content: loserContent })).rejects.toThrow(RejectedValueError);
  });

  it('raw loser via resolve --forget no longer throws (kind-aware removal)', async () => {
    const a = createMemory('keeper content for raw conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content', { tags: ['x'], kind: 'raw' });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    replaceDetectedConflicts(tmpDir, [
      {
        memoryAId: a.id,
        memoryBId: rawLoser.id,
        reason: 'raw conflict',
        score: 0.85,
      },
    ]);
    const conflicts = await listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    await expect(api.conflictResolve(ctx(), conflictId, { keepId: a.id, forget: true })).resolves.toEqual({
      conflictId,
      keptId: a.id,
      loserId: rawLoser.id,
    });
    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('archived_raw');
    } finally {
      closeHippoDb(db);
    }
  });

  it('raw loser via PLAIN resolve --forget (no --reject-loser) purges its mirror + stamps mirror_cleaned_at', async () => {
    const a = createMemory('keeper content for raw mirror-purge conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content for the mirror-purge test', { tags: ['x'], kind: 'raw' });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    const mirrorPath = path.join(tmpDir, Layer.Episodic, `${rawLoser.id}.md`);
    expect(fs.existsSync(mirrorPath)).toBe(true);

    replaceDetectedConflicts(tmpDir, [
      {
        memoryAId: a.id,
        memoryBId: rawLoser.id,
        reason: 'raw conflict for mirror-purge test',
        score: 0.85,
      },
    ]);
    const conflicts = await listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    await api.conflictResolve(ctx(), conflictId, { keepId: a.id, forget: true });
    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();
    expect(fs.existsSync(mirrorPath)).toBe(false);

    const db = openHippoDb(tmpDir);
    try {
      // SAFETY: row's shape matches the single `mirror_cleaned_at` column
      // named in the SELECT above.
      const row = db.prepare(`SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`).get(rawLoser.id) as
        | { mirror_cleaned_at: string | null }
        | undefined;
      expect(row?.mirror_cleaned_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue on a RAW loser: tombstone written, raw archived (not deleted), no crash — previously untested combination (GDPR pairing)', async () => {
    const a = createMemory('keeper content for raw+reject conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content later rejected via the reject-loser path', {
      tags: ['x'],
      kind: 'raw',
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    replaceDetectedConflicts(tmpDir, [
      {
        memoryAId: a.id,
        memoryBId: rawLoser.id,
        reason: 'raw+reject conflict',
        score: 0.85,
      },
    ]);
    const conflicts = await listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    await expect(
      api.conflictResolve(ctx(), conflictId, {
        keepId: a.id,
        rejectLoser: true,
        reason: 'raw loser rejected via GDPR-adjacent path',
      }),
    ).resolves.toEqual({ conflictId, keptId: a.id, loserId: rawLoser.id });

    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();
    const db = openHippoDb(tmpDir);
    try {
      const archiveRow = db.prepare(`SELECT memory_id FROM raw_archive WHERE memory_id = ?`).get(rawLoser.id);
      expect(archiveRow).not.toBeUndefined();
    } finally {
      closeHippoDb(db);
    }

    await expect(
      api.remember(ctx(), { content: 'raw loser content later rejected via the reject-loser path' }),
    ).rejects.toThrow(RejectedValueError);

    const db2 = openHippoDb(tmpDir);
    try {
      const events = listAuditEvents(db2, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('archived_raw');
      expect(events[0]!.metadata.rejected).toBe(true);
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('supersedeMemory write-order contract', () => {
  it('a refused successor write leaves the old row without a dangling superseded_by pointer', async () => {
    const old = createMemory('the old belief to correct', { tags: ['s'] });
    writeEntry(tmpDir, old);

    await api.reject(ctx(), { value: 'the corrected but rejected belief', reason: 'known-bad correction' });

    const newEntry = createMemory('the corrected but rejected belief', {
      tags: ['s'],
      confidence: 'verified',
    });

    expect(() => writeEntry(tmpDir, newEntry)).toThrow(RejectedValueError);

    const oldAfter = readEntry(tmpDir, old.id);
    expect(oldAfter).not.toBeNull();
    expect(oldAfter!.supersededBy).toBeNull();
    expect(readEntry(tmpDir, newEntry.id)).toBeNull();
  });
});

describe('tombstones of rows with a lead-in', () => {
  const L1 = 'user: Is the flight booked?';
  const L2 = 'user: Did Mel get the job?';
  const L3 = 'user: Is the hotel paid?';
  const host = (): FullContext => apiCtx(tmpDir, 'default', api.adminActor('cli'));

  const put = (content: string, leadIn?: string): string => {
    const entry = createMemory(content, { tags: ['x'], leadIn });
    writeEntry(tmpDir, entry);
    return entry.id;
  };
  const refused = (content: string, leadIn?: string): boolean => {
    try {
      writeEntry(tmpDir, createMemory(content, { tags: ['x'], leadIn }));
      return false;
    } catch (err) {
      if (err instanceof RejectedValueError) return true;
      throw err;
    }
  };

  it('rejecting "Yes."+L1 by id removes it, keeps "Yes."+L2, and refuses only a new "Yes."+L1', async () => {
    const one = put('Yes.', L1);
    const two = put('Yes.', L2);
    const bare = put('Yes.');

    const result = await api.rejectOnHost(host(), { memoryId: one, reason: 'wrong answer' });

    expect(result.removedIds).toEqual([one]);
    expect(result.leadInOnly).toBe(true);
    expect(result.digest).toBe(tombstoneDigest({ content: 'Yes.', leadIn: L1 }));
    expect([readEntry(tmpDir, one), readEntry(tmpDir, two)?.id, readEntry(tmpDir, bare)?.id]).toEqual([
      null,
      two,
      bare,
    ]);
    expect(refused('Yes.', L1)).toBe(true);
    expect(refused('Yes.', `  ${L1.replace(/ /g, '   ')}`)).toBe(true);
    expect(refused('Yes.', L3)).toBe(false);
    expect(refused('Yes.')).toBe(false);
  });

  it('a value rejection of "Yes." removes "Yes."+L1 and "Yes."+L2, and refuses "Yes."+L3', async () => {
    const one = put('Yes.', L1);
    const two = put('Yes.', L2);

    const result = await api.rejectOnHost(host(), { value: 'yes.', reason: 'never say it' });

    expect(result.removedIds.slice().sort()).toEqual([one, two].sort());
    expect(result.leadInOnly).toBe(false);
    expect(result.digest).toBe(rejectionDigest('Yes.'));
    expect(refused('Yes.', L3)).toBe(true);
    expect(refused('Yes.')).toBe(true);
  });

  it('rejecting a row with no lead-in by id keeps its one digest and still removes every "Yes."', async () => {
    const bare = put('Yes.');
    const one = put('Yes.', L1);

    const result = await api.rejectOnHost(host(), { memoryId: bare, reason: 'bare reply' });

    expect(rowDigests({ content: 'Yes.', leadIn: null })).toEqual([rejectionDigest('Yes.')]);
    expect(result.digest).toBe(rejectionDigest('Yes.'));
    expect(result.leadInOnly).toBe(false);
    expect(result.removedIds.slice().sort()).toEqual([bare, one].sort());
    expect(await listRejectionsForTenant(sqliteStore(tmpDir), 'default')).toHaveLength(1);
  });

  it('after a lost conflict on "Yes."+L1, a new "Yes."+L1 is refused; "Yes." and "Yes."+L2 stay', async () => {
    const keep = put('Yes, the flight is booked for Friday', L3);
    const loser = put('Yes.', L1);
    const two = put('Yes.', L2);
    const bare = put('Yes.');
    replaceDetectedConflicts(tmpDir, [
      { memoryAId: keep, memoryBId: loser, reason: 'contradicting answers', score: 0.85 },
    ]);
    const conflictId = (await listMemoryConflicts(tmpDir, 'open'))[0]!.id;

    await api.conflictResolve(ctx(), conflictId, { keepId: keep, rejectLoser: true, reason: 'wrong answer' });

    expect([readEntry(tmpDir, loser), readEntry(tmpDir, two)?.id, readEntry(tmpDir, bare)?.id]).toEqual([
      null,
      two,
      bare,
    ]);
    expect(refused('Yes.', L1)).toBe(true);
    expect(refused('Yes.', L3)).toBe(false);
    const rows = await listRejectionsForTenant(sqliteStore(tmpDir), 'default');
    expect(rows.map((r) => r.digest)).toEqual([tombstoneDigest({ content: 'Yes.', leadIn: L1 })]);
  });

  it('a conflict loser with no lead-in writes the content digest, as before', async () => {
    const keep = put('Always use semicolons in PowerShell');
    const loser = put('Use && to chain commands in PowerShell');
    replaceDetectedConflicts(tmpDir, [
      { memoryAId: keep, memoryBId: loser, reason: 'contradictory chaining advice', score: 0.85 },
    ]);
    const conflictId = (await listMemoryConflicts(tmpDir, 'open'))[0]!.id;

    await api.conflictResolve(ctx(), conflictId, { keepId: keep, rejectLoser: true, reason: 'wrong' });

    const rows = await listRejectionsForTenant(sqliteStore(tmpDir), 'default');
    expect(rows.map((r) => r.digest)).toEqual([rejectionDigest('Use && to chain commands in PowerShell')]);
  });
});
