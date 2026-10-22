// The rejections group on hippo.db: what each writes, and what a refusal leaves unwritten.

import { beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import type { Rejection } from '../../src/store/port/rejections.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import type { AuditEvent } from '../../src/store/port/types.js';
import type { AuditOp } from '../../src/base/records/audit-ops.js';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let root: string;
// Another person's personal scope, which a rejection with no personal scope of its own leaves alone.
const ELSEWHERE = 'personal:private:someone-else';
const rejections = (): ReturnType<typeof sqliteStore>['rejections'] => sqliteStore(root).rejections;

beforeEach(() => {
  root = makeRoot('rejected-values');
});

function auditRows(tenantId: string, op: AuditOp): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return queryAuditEvents(db, { tenantId, op });
  } finally {
    closeHippoDb(db);
  }
}

function rejection(tenantId: string, over: Partial<Rejection>): Rejection {
  return {
    tenantId,
    actor: 'tester',
    reason: 'wrong',
    ownScope: null,
    ...over,
  };
}

async function rejectText(tenantId: string, text: string): Promise<string> {
  return (await rejections().apply(rejection(tenantId, { value: text }))).digest;
}

describe('rejections.apply', () => {
  it('rejects the text of the row the memory id names, removes that row and writes one reject_value row', async () => {
    const entry = createMemory('the build runs on node 18', { tags: [] });
    writeEntry(root, entry);

    const applied = await rejections().apply(rejection('default', { memoryId: entry.id }));

    expect(applied).toMatchObject({
      digest: rejectionDigest(entry.content),
      content: entry.content,
      removedIds: [entry.id],
    });
    expect(readEntry(root, entry.id)).toBeNull();
    expect(await rejections().list('default')).toMatchObject([
      { digest: applied.digest, reason: 'wrong', rejectedBy: 'tester', sourceMemoryId: entry.id },
    ]);
    expect(auditRows('default', 'reject_value')).toMatchObject([
      { actor: 'tester', targetId: entry.id, metadata: { digest: applied.digest, removedIds: [entry.id], count: 1 } },
    ]);
  });

  it('writes nothing when the memory id names no row, or a personal one', async () => {
    const own = createMemory('my own reminder', { tags: [], scope: ELSEWHERE });
    writeEntry(root, own);

    await expect(rejections().apply(rejection('default', { memoryId: 'mem_absent' }))).rejects.toThrow(
      'memory not found: mem_absent',
    );
    await expect(rejections().apply(rejection('default', { memoryId: own.id }))).rejects.toThrow(
      "Personal memories can't be rejected",
    );

    expect(await rejections().list('default')).toEqual([]);
    expect(auditRows('default', 'reject_value')).toEqual([]);
  });

  it("leaves another person's personal row holding the text, and removes the caller's own", async () => {
    const entry = createMemory('kept out of reach', { tags: [], scope: ELSEWHERE });
    writeEntry(root, entry);

    const applied = await rejections().apply(rejection('default', { value: entry.content }));

    expect(applied.removedIds).toEqual([]);
    expect(readEntry(root, entry.id)).not.toBeNull();
    expect(
      (await rejections().apply(rejection('default', { value: entry.content, ownScope: ELSEWHERE }))).removedIds,
    ).toEqual([entry.id]);
  });
});

describe('rejections.lift', () => {
  it('deletes the one match and writes an unreject_value row naming its digest, reason and source memory', async () => {
    const entry = createMemory('lifted later', { tags: [] });
    writeEntry(root, entry);
    const { digest } = await rejections().apply(rejection('default', { memoryId: entry.id, reason: 'stale' }));

    expect(await rejections().lift('default', digest.slice(0, 12), 'lifter')).toEqual({
      status: 'ok',
      digest,
      reason: 'stale',
    });

    expect(await rejections().list('default')).toEqual([]);
    expect(auditRows('default', 'unreject_value')).toMatchObject([
      { actor: 'lifter', targetId: entry.id, metadata: { digest, reason: 'stale' } },
    ]);
  });

  it('deletes nothing and writes no audit row when the prefix matches two rejected values', async () => {
    const digests = [await rejectText('default', 'first value'), await rejectText('default', 'second value')];

    const outcome = await rejections().lift('default', '', 'lifter');

    expect(outcome.status).toBe('ambiguous');
    expect(outcome.status === 'ambiguous' ? outcome.candidates.map((c) => c.digest).sort() : []).toEqual(
      [...digests].sort(),
    );
    expect(await rejections().list('default')).toHaveLength(2);
    expect(auditRows('default', 'unreject_value')).toEqual([]);
  });

  it("neither lists nor lifts another tenant's rejected value", async () => {
    const digest = await rejectText('tenant-a', 'only tenant a rejects this');

    expect(await rejections().list('tenant-b')).toEqual([]);
    expect(await rejections().lift('tenant-b', digest, 'lifter')).toEqual({ status: 'not_found' });
    expect((await rejections().list('tenant-a')).map((r) => r.digest)).toEqual([digest]);
  });
});

const refused = (tenantId: string, entryId: string, content: string): Promise<boolean[]> =>
  sqliteStore(root).rejections.refusedAmong([{ tenantId, entryId, content }]);

describe('rejections.refusedAmong', () => {
  it('is true only for the rejected text in the tenant that rejected it, and writes neither a row nor a refusal', async () => {
    await rejectText('tenant-a', 'never store this again');
    const entry = createMemory('Never  store this AGAIN', { tags: [] });

    expect(
      await sqliteStore(root).rejections.refusedAmong([
        { tenantId: 'tenant-a', entryId: entry.id, content: entry.content },
        { tenantId: 'tenant-b', entryId: entry.id, content: entry.content },
        { tenantId: 'tenant-a', entryId: entry.id, content: 'some other text' },
      ]),
    ).toEqual([true, false, false]);

    expect(readEntry(root, entry.id)).toBeNull();
    expect(auditRows('tenant-a', 'reject_refusal')).toEqual([]);
  });

  it('is false for the row that already holds the rejected text and true for a new id bringing it in', async () => {
    const entry = createMemory('held before the rejection', { tags: [], scope: ELSEWHERE });
    writeEntry(root, entry);
    await rejections().apply(rejection('default', { value: entry.content }));

    expect(await refused('default', entry.id, entry.content)).toEqual([false]);
    expect(await refused('default', 'mem_other_id', entry.content)).toEqual([true]);
  });
});
