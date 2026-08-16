/**
 * AT1 T2 smoke tests: reject/unreject/rejections (api.ts + src/reject-flow.ts)
 * and resolveConflict's rejectLoserValue + audit wiring.
 * docs/plans/2026-08-15-at1-rejected-value-tombstone.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, Layer } from '../src/memory.js';
import {
  initStore,
  writeEntry,
  readEntry,
  listMemoryConflicts,
  replaceDetectedConflicts,
  resolveConflict,
} from '../src/store.js';
import { queryAuditEvents } from '../src/audit.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import * as api from '../src/api.js';
import { RejectedValueError } from '../src/rejection.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-reject-verbs-'));
  initStore(tmpDir);
});

function ctx(tenantId: string = 'default'): api.Context {
  return { hippoRoot: tmpDir, tenantId, actor: { subject: 'cli', role: 'admin' } };
}

describe('api.reject / api.unreject / api.listRejections', () => {
  it('reject by id removes the row + all same-digest duplicates, one reject_value audit, zero forget audits', () => {
    const a = createMemory('duplicate offending value', { tags: ['x'] });
    const b = createMemory('DUPLICATE OFFENDING VALUE', { tags: ['y'] }); // same normalized digest
    const unrelated = createMemory('unrelated safe value', { tags: ['z'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    writeEntry(tmpDir, unrelated);

    const result = api.reject(ctx(), { memoryId: a.id, reason: 'test rejection' });
    expect(result.removedIds.slice().sort()).toEqual([a.id, b.id].sort());

    expect(readEntry(tmpDir, a.id)).toBeNull();
    expect(readEntry(tmpDir, b.id)).toBeNull();
    expect(readEntry(tmpDir, unrelated.id)).not.toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const rejectEvents = queryAuditEvents(db, { tenantId: 'default', op: 'reject_value' });
      expect(rejectEvents.length).toBe(1);
      expect(rejectEvents[0]!.metadata.digest).toBe(result.digest);
      expect(rejectEvents[0]!.metadata.count).toBe(2);

      const forgetEvents = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(forgetEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('reject purges the trace-layer markdown mirror (P1 fix: removeEntryMirrors previously skipped Layer.Trace)', () => {
    const trace = createMemory('trace: read config.ts -> rotated the deploy key -> success', {
      layer: Layer.Trace,
      trace_outcome: 'success',
    });
    writeEntry(tmpDir, trace);
    const mirrorPath = path.join(tmpDir, Layer.Trace, `${trace.id}.md`);
    expect(fs.existsSync(mirrorPath)).toBe(true);

    api.reject(ctx(), { memoryId: trace.id, reason: 'trace content was wrong' });
    expect(readEntry(tmpDir, trace.id)).toBeNull();
    expect(fs.existsSync(mirrorPath)).toBe(false);
  });

  it('rejections lists the tombstone', () => {
    const a = createMemory('to be rejected', { tags: [] });
    writeEntry(tmpDir, a);
    api.reject(ctx(), { memoryId: a.id, reason: 'listed test' });

    const rows = api.listRejections(ctx());
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toBe('listed test');
    expect(rows[0]!.sourceMemoryId).toBe(a.id);
  });

  it('re-remember of the rejected value is refused', () => {
    const a = createMemory('refuse me please', { tags: [] });
    writeEntry(tmpDir, a);
    api.reject(ctx(), { memoryId: a.id, reason: 'refused' });

    expect(() => api.remember(ctx(), { content: 'refuse me please' })).toThrow(RejectedValueError);
  });

  it('unreject then re-remember succeeds', () => {
    const a = createMemory('temporarily rejected', { tags: [] });
    writeEntry(tmpDir, a);
    const rejectResult = api.reject(ctx(), { memoryId: a.id, reason: 'temp' });

    const unrejectResult = api.unreject(ctx(), rejectResult.digest);
    expect(unrejectResult.ok).toBe(true);
    expect(api.listRejections(ctx()).length).toBe(0);

    expect(() => api.remember(ctx(), { content: 'temporarily rejected' })).not.toThrow();
  });

  it('reject --value pre-emptive path: zero removals, still refuses a later write', () => {
    const result = api.reject(ctx(), { value: 'never seen before value', reason: 'pre-emptive' });
    expect(result.removedIds.length).toBe(0);

    expect(() => api.remember(ctx(), { content: 'never seen before value' })).toThrow(RejectedValueError);
  });

  it('reject requires a non-empty reason', () => {
    const a = createMemory('needs a reason', { tags: [] });
    writeEntry(tmpDir, a);
    expect(() => api.reject(ctx(), { memoryId: a.id, reason: '' })).toThrow();
  });

  it('reject throws when both memoryId and value are given (P2 fix)', () => {
    const a = createMemory('both forms supplied at once', { tags: [] });
    writeEntry(tmpDir, a);
    expect(() =>
      api.reject(ctx(), { memoryId: a.id, value: 'a different value entirely', reason: 'ambiguous' }),
    ).toThrow();
  });

  it('unreject throws on a blank digest/prefix instead of matching every tombstone (P2 fix)', () => {
    const a = createMemory('to be rejected for the blank-unreject test', { tags: [] });
    writeEntry(tmpDir, a);
    api.reject(ctx(), { memoryId: a.id, reason: 'setup for blank-unreject test' });
    expect(api.listRejections(ctx()).length).toBe(1);

    expect(() => api.unreject(ctx(), '')).toThrow();
    expect(() => api.unreject(ctx(), '   ')).toThrow();
    // The tombstone must survive an accidental blank call, not get wiped by
    // an empty-string startsWith-matches-everything prefix scan.
    expect(api.listRejections(ctx()).length).toBe(1);
  });
});

describe('resolveConflict AT1 wiring', () => {
  function seedConflict() {
    const a = createMemory('Always use semicolons in PowerShell', { tags: ['x'] });
    const b = createMemory('Use && to chain commands in PowerShell', { tags: ['x'] });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [{
      memory_a_id: a.id,
      memory_b_id: b.id,
      reason: 'contradictory chaining advice',
      score: 0.85,
    }]);
    const conflicts = listMemoryConflicts(tmpDir, 'open');
    return { aId: a.id, bId: b.id, conflictId: conflicts[0]!.id };
  }

  it('legacy 5-arg call shape still works and now writes a conflict_resolve audit (previously zero)', () => {
    const { aId, conflictId } = seedConflict();
    const result = resolveConflict(tmpDir, conflictId, aId, false, 'default'); // 5 args, no opts
    expect(result).not.toBeNull();
    expect(result!.conflict.status).toBe('resolved');

    const db = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('weakened');
      expect(events[0]!.metadata.rejected).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('resolveConflict --forget writes a conflict_resolve audit with disposition=deleted', () => {
    const { aId, bId, conflictId } = seedConflict();
    resolveConflict(tmpDir, conflictId, aId, true, 'default');
    expect(readEntry(tmpDir, bId)).toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('deleted');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue tombstones + removes the loser; re-remember of its content is refused', () => {
    const { aId, bId, conflictId } = seedConflict();
    const result = resolveConflict(tmpDir, conflictId, aId, false, 'default', {
      rejectLoserValue: true,
      reason: 'loser rejected',
    });
    expect(result).not.toBeNull();
    expect(readEntry(tmpDir, bId)).toBeNull();

    expect(() =>
      api.remember(ctx(), { content: 'Use && to chain commands in PowerShell' }),
    ).toThrow(RejectedValueError);

    const db = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.rejected).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue removes a same-tenant same-digest duplicate but leaves an identical-content row in ANOTHER tenant untouched (P1 fix)', () => {
    const { aId, bId, conflictId } = seedConflict();
    const loserContent = 'Use && to chain commands in PowerShell';

    // Same-tenant duplicate of the loser's content — must be swept up too.
    const dup = createMemory(loserContent, { tags: ['dup'] });
    writeEntry(tmpDir, dup);

    // Identical content in a DIFFERENT tenant — tombstones are tenant-scoped
    // by design; this row must survive untouched.
    const otherTenantDup = createMemory(loserContent, { tags: ['dup'], tenantId: 'other-tenant' });
    writeEntry(tmpDir, otherTenantDup);

    const result = resolveConflict(tmpDir, conflictId, aId, false, 'default', {
      rejectLoserValue: true,
      reason: 'loser + same-tenant duplicates rejected',
    });
    expect(result).not.toBeNull();

    expect(readEntry(tmpDir, bId)).toBeNull();
    expect(readEntry(tmpDir, dup.id)).toBeNull();
    expect(readEntry(tmpDir, otherTenantDup.id, 'other-tenant')).not.toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      // SAFETY: resolveConflict's conflict_resolve audit always writes
      // metadata.removedIds as string[] (src/store.ts's conflictResolveMeta).
      const removedIds = events[0]!.metadata.removedIds as string[];
      expect(removedIds.slice().sort()).toEqual([bId, dup.id].sort());
    } finally {
      closeHippoDb(db);
    }

    expect(() => api.remember(ctx(), { content: loserContent })).toThrow(RejectedValueError);
  });

  it('raw loser via resolve --forget no longer throws (kind-aware removal)', () => {
    const a = createMemory('keeper content for raw conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content', { tags: ['x'], kind: 'raw' });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    replaceDetectedConflicts(tmpDir, [{
      memory_a_id: a.id,
      memory_b_id: rawLoser.id,
      reason: 'raw conflict',
      score: 0.85,
    }]);
    const conflicts = listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    expect(() => resolveConflict(tmpDir, conflictId, a.id, true, 'default')).not.toThrow();
    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();

    const db = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('archived_raw');
    } finally {
      closeHippoDb(db);
    }
  });

  it('raw loser via PLAIN resolve --forget (no --reject-loser) purges its mirror + stamps mirror_cleaned_at (P1b fix)', () => {
    const a = createMemory('keeper content for raw mirror-purge conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content for the mirror-purge test', { tags: ['x'], kind: 'raw' });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    const mirrorPath = path.join(tmpDir, Layer.Episodic, `${rawLoser.id}.md`);
    expect(fs.existsSync(mirrorPath)).toBe(true);

    replaceDetectedConflicts(tmpDir, [{
      memory_a_id: a.id,
      memory_b_id: rawLoser.id,
      reason: 'raw conflict for mirror-purge test',
      score: 0.85,
    }]);
    const conflicts = listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    // Plain --forget, deliberately WITHOUT rejectLoserValue — before P1b the
    // post-commit purge gate required rejectLoserValue too, so this path
    // left the raw mirror orphaned (only the reaper would eventually catch
    // it; a non-raw loser would never be caught at all).
    resolveConflict(tmpDir, conflictId, a.id, true, 'default');
    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();
    expect(fs.existsSync(mirrorPath)).toBe(false);

    const db = openHippoDb(tmpDir);
    try {
      // SAFETY: row's shape matches the single `mirror_cleaned_at` column
      // named in the SELECT above.
      const row = db
        .prepare(`SELECT mirror_cleaned_at FROM raw_archive WHERE memory_id = ?`)
        .get(rawLoser.id) as { mirror_cleaned_at: string | null } | undefined;
      expect(row?.mirror_cleaned_at).toBeTruthy();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rejectLoserValue on a RAW loser: tombstone written, raw archived (not deleted), no crash — previously untested combination (GDPR pairing)', () => {
    const a = createMemory('keeper content for raw+reject conflict', { tags: ['x'] });
    const rawLoser = createMemory('raw loser content later rejected via the reject-loser path', {
      tags: ['x'],
      kind: 'raw',
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, rawLoser);
    replaceDetectedConflicts(tmpDir, [{
      memory_a_id: a.id,
      memory_b_id: rawLoser.id,
      reason: 'raw+reject conflict',
      score: 0.85,
    }]);
    const conflicts = listMemoryConflicts(tmpDir, 'open');
    const conflictId = conflicts[0]!.id;

    expect(() =>
      resolveConflict(tmpDir, conflictId, a.id, false, 'default', {
        rejectLoserValue: true,
        reason: 'raw loser rejected via GDPR-adjacent path',
      }),
    ).not.toThrow();

    // Archived, not hard-deleted: the row is gone from `memories` but a
    // raw_archive row exists (append-only trigger respected).
    expect(readEntry(tmpDir, rawLoser.id)).toBeNull();
    const db = openHippoDb(tmpDir);
    try {
      const archiveRow = db.prepare(`SELECT memory_id FROM raw_archive WHERE memory_id = ?`).get(rawLoser.id);
      expect(archiveRow).not.toBeUndefined();
    } finally {
      closeHippoDb(db);
    }

    // Tombstone written: re-remembering the raw loser's content is refused.
    expect(() =>
      api.remember(ctx(), { content: 'raw loser content later rejected via the reject-loser path' }),
    ).toThrow(RejectedValueError);

    const db2 = openHippoDb(tmpDir);
    try {
      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'conflict_resolve' });
      expect(events.length).toBe(1);
      expect(events[0]!.metadata.disposition).toBe('archived_raw');
      expect(events[0]!.metadata.rejected).toBe(true);
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('cmdSupersede write-order contract (code-review round-1 high)', () => {
  it('a refused successor write leaves the old row without a dangling superseded_by pointer', () => {
    // Replicates cmdSupersede's REORDERED two-write flow (cli.ts): the
    // successor is written FIRST so the rejection guard fires before any
    // mutation of the old row. The old ordering committed
    // old.superseded_by = newEntry.id before the guarded write, leaving a
    // dangling pointer to an id that was never created.
    const old = createMemory('the old belief to correct', { tags: ['s'] });
    writeEntry(tmpDir, old);

    api.reject(ctx(), { value: 'the corrected but rejected belief', reason: 'known-bad correction' });

    const newEntry = createMemory('the corrected but rejected belief', {
      tags: ['s'],
      confidence: 'verified',
    });

    // Successor write first: refused, and nothing has been mutated.
    expect(() => writeEntry(tmpDir, newEntry)).toThrow(RejectedValueError);

    // The old row must be untouched: no dangling pointer, still live.
    const oldAfter = readEntry(tmpDir, old.id);
    expect(oldAfter).not.toBeNull();
    expect(oldAfter!.superseded_by).toBeNull();
    // And the successor id must not exist.
    expect(readEntry(tmpDir, newEntry.id)).toBeNull();
  });
});
