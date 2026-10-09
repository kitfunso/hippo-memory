// applyRejection, liftRejection, loadRejectedValues and rejectionGuardRefuses against a real store: what each writes, and what a refusal leaves unwritten.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { queryAuditEvents, type AuditEvent, type AuditOp } from '../src/store/audit.js';
import { readEntry } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { applyRejection, liftRejection, loadRejectedValues, rejectionGuardRefuses, type Rejection, type RejectionSource } from '../src/store/rejected-values.js';
import { rejectionDigest } from '../src/store/rejection.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-rejected-values-'));
  initStore(root);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function auditRows(tenantId: string, op: AuditOp): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return queryAuditEvents(db, { tenantId, op });
  } finally {
    closeHippoDb(db);
  }
}

function rejection(tenantId: string, over: Partial<Rejection>): Rejection {
  return { tenantId, actor: 'tester', reason: 'wrong', textOf: () => 'unused', inReach: () => true, successorOf: () => undefined, ...over };
}

function rejectText(tenantId: string, text: string): string {
  return applyRejection(root, rejection(tenantId, { textOf: () => text })).digest;
}

describe('applyRejection', () => {
  it('hands textOf the row the memory id names, removes that row and writes one reject_value row', () => {
    const entry = createMemory('the build runs on node 18', { tags: [] });
    writeEntry(root, entry);
    const seen: Array<RejectionSource | undefined> = [];

    const applied = applyRejection(root, rejection('default', {
      memoryId: entry.id,
      textOf: (source) => { seen.push(source); return source?.content ?? ''; },
    }));

    expect(seen).toEqual([{ content: entry.content, tenant_id: 'default', scope: null }]);
    expect(applied).toMatchObject({ digest: rejectionDigest(entry.content), content: entry.content, removedIds: [entry.id] });
    expect(readEntry(root, entry.id)).toBeNull();
    expect(loadRejectedValues(root, 'default')).toMatchObject([{ digest: applied.digest, reason: 'wrong', rejectedBy: 'tester', sourceMemoryId: entry.id }]);
    expect(auditRows('default', 'reject_value')).toMatchObject([
      { actor: 'tester', targetId: entry.id, metadata: { digest: applied.digest, removedIds: [entry.id], count: 1 } },
    ]);
  });

  it('writes nothing when textOf refuses, and tells it that no row holds the id', () => {
    const seen: Array<RejectionSource | undefined> = [];
    const refuse = (source: RejectionSource | undefined): string => { seen.push(source); throw new Error('refused'); };

    expect(() => applyRejection(root, rejection('default', { memoryId: 'mem_absent', textOf: refuse }))).toThrow('refused');

    expect(seen).toEqual([undefined]);
    expect(loadRejectedValues(root, 'default')).toEqual([]);
    expect(auditRows('default', 'reject_value')).toEqual([]);
  });

  it('leaves a row holding the text when inReach turns its scope away', () => {
    const entry = createMemory('kept out of reach', { tags: [] });
    writeEntry(root, entry);

    const applied = applyRejection(root, rejection('default', { textOf: () => entry.content, inReach: () => false }));

    expect(applied.removedIds).toEqual([]);
    expect(readEntry(root, entry.id)).not.toBeNull();
  });
});

describe('liftRejection', () => {
  it('deletes the one match and writes an unreject_value row naming its digest, reason and source memory', () => {
    const entry = createMemory('lifted later', { tags: [] });
    writeEntry(root, entry);
    const { digest } = applyRejection(root, rejection('default', { memoryId: entry.id, reason: 'stale', textOf: (source) => source?.content ?? '' }));

    expect(liftRejection(root, 'default', digest.slice(0, 12), 'lifter')).toEqual({ status: 'ok', digest, reason: 'stale' });

    expect(loadRejectedValues(root, 'default')).toEqual([]);
    expect(auditRows('default', 'unreject_value')).toMatchObject([{ actor: 'lifter', targetId: entry.id, metadata: { digest, reason: 'stale' } }]);
  });

  it('deletes nothing and writes no audit row when the prefix matches two rejected values', () => {
    const digests = [rejectText('default', 'first value'), rejectText('default', 'second value')];

    const outcome = liftRejection(root, 'default', '', 'lifter');

    expect(outcome.status).toBe('ambiguous');
    expect(outcome.status === 'ambiguous' ? outcome.candidates.map((c) => c.digest).sort() : []).toEqual([...digests].sort());
    expect(loadRejectedValues(root, 'default')).toHaveLength(2);
    expect(auditRows('default', 'unreject_value')).toEqual([]);
  });

  it("neither lists nor lifts another tenant's rejected value", () => {
    const digest = rejectText('tenant-a', 'only tenant a rejects this');

    expect(loadRejectedValues(root, 'tenant-b')).toEqual([]);
    expect(liftRejection(root, 'tenant-b', digest, 'lifter')).toEqual({ status: 'not_found' });
    expect(loadRejectedValues(root, 'tenant-a').map((r) => r.digest)).toEqual([digest]);
  });
});

describe('rejectionGuardRefuses', () => {
  it('is true only for the rejected text in the tenant that rejected it, and writes neither a row nor a refusal', () => {
    rejectText('tenant-a', 'never store this again');
    const entry = createMemory('Never  store this AGAIN', { tags: [] });

    expect(rejectionGuardRefuses(root, 'tenant-a', entry.id, entry.content)).toBe(true);
    expect(rejectionGuardRefuses(root, 'tenant-b', entry.id, entry.content)).toBe(false);
    expect(rejectionGuardRefuses(root, 'tenant-a', entry.id, 'some other text')).toBe(false);

    expect(readEntry(root, entry.id)).toBeNull();
    expect(auditRows('tenant-a', 'reject_refusal')).toEqual([]);
  });

  it('is false for the row that already holds the rejected text and true for a new id bringing it in', () => {
    const entry = createMemory('held before the rejection', { tags: [] });
    writeEntry(root, entry);
    applyRejection(root, rejection('default', { textOf: () => entry.content, inReach: () => false }));

    expect(rejectionGuardRefuses(root, 'default', entry.id, entry.content)).toBe(false);
    expect(rejectionGuardRefuses(root, 'default', 'mem_other_id', entry.content)).toBe(true);
  });
});
