// Sleep's tombstone checks answer per tenant, write their refusal rows through the store, and do nothing under a dry run.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { makeRoot } from '../_helpers/make-root.js';
import type { AppendAuditOpts } from '../../src/store/port/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { tombstoneChecks as checksOver } from '../../src/domain/consolidate/tombstones.js';

const roots: string[] = [];
const DIGEST = rejectionDigest('the staging password is hunter2');

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A store where tenant `ta` has rejected one value. */
function storeWithTombstone(): string {
  const root = makeRoot('tombstone-checks');
  roots.push(root);
  const db = openHippoDb(root);
  try {
    insertRejectedValue(db, {
      tenantId: 'ta',
      digest: DIGEST,
      reason: 'leaked',
      rejectedBy: 'test',
      rejectedAt: '2026-06-01T12:00:00.000Z',
      normalizedChars: 31,
    });
  } finally {
    closeHippoDb(db);
  }
  return root;
}

function refusals(root: string, tenantId: string) {
  const db = openHippoDb(root);
  try {
    return queryAuditEvents(db, { tenantId, op: 'reject_refusal' });
  } finally {
    closeHippoDb(db);
  }
}

const refusal = (targetId: string): AppendAuditOpts => ({
  tenantId: 'ta',
  actor: 'sleep',
  op: 'reject_refusal',
  targetId,
  metadata: { digest: DIGEST },
});

const tombstoneChecks = (root: string, dryRun: boolean) => checksOver(sqliteStore(root), dryRun);

describe('tombstoneChecks', () => {
  it('finds a tombstone only under the tenant that rejected the value, and writes the refusal row', async () => {
    const root = storeWithTombstone();
    const checks = tombstoneChecks(root, false);
    expect((await checks.find('ta', DIGEST))?.reason).toBe('leaked');
    expect(await checks.find('tb', DIGEST)).toBeNull();
    expect(await checks.find('ta', rejectionDigest('another value'))).toBeNull();
    await checks.audit(refusal('m1'));
    expect(refusals(root, 'ta').map((e) => [e.actor, e.targetId, e.metadata])).toEqual([
      ['sleep', 'm1', { digest: DIGEST }],
    ]);
  });

  it('under a dry run finds nothing, writes nothing and never opens the store', async () => {
    const root = storeWithTombstone();
    const checks = tombstoneChecks(path.join(root, 'no-store-here'), true);
    expect(await checks.find('ta', DIGEST)).toBeNull();
    await checks.audit(refusal('m1'));
    expect(fs.existsSync(path.join(root, 'no-store-here'))).toBe(false);
  });

  it('an unused set of checks never opens the store', () => {
    const root = storeWithTombstone();
    tombstoneChecks(path.join(root, 'no-store-here'), false);
    expect(fs.existsSync(path.join(root, 'no-store-here'))).toBe(false);
  });
});
