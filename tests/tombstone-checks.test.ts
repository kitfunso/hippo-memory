// Sleep's tombstone checks answer per tenant on one lazily opened handle, write their refusal rows on it, and do nothing under a dry run.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { queryAuditEvents, type AppendAuditOpts } from '../src/store/audit.js';
import { insertRejectedValue, rejectionDigest } from '../src/store/rejection.js';
import { lazyTombstoneChecks } from '../src/store/tombstone-checks.js';

const roots: string[] = [];
const DIGEST = rejectionDigest('the staging password is hunter2');

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A store where tenant `ta` has rejected one value. */
function storeWithTombstone(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-tombstone-checks-'));
  roots.push(root);
  initStore(root);
  const db = openHippoDb(root);
  try {
    insertRejectedValue(db, { tenantId: 'ta', digest: DIGEST, reason: 'leaked', rejectedBy: 'test', rejectedAt: '2026-06-01T12:00:00.000Z', normalizedChars: 31 });
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

const refusal = (targetId: string): AppendAuditOpts => ({ tenantId: 'ta', actor: 'sleep', op: 'reject_refusal', targetId, metadata: { digest: DIGEST } });

describe('lazyTombstoneChecks', () => {
  it('finds a tombstone only under the tenant that rejected the value, and writes the refusal row', () => {
    const root = storeWithTombstone();
    const checks = lazyTombstoneChecks(root, false);
    try {
      expect(checks.find('ta', DIGEST)?.reason).toBe('leaked');
      expect(checks.find('tb', DIGEST)).toBeNull();
      expect(checks.find('ta', rejectionDigest('another value'))).toBeNull();
      checks.audit(refusal('m1'));
    } finally {
      checks.close();
    }
    expect(refusals(root, 'ta').map((e) => [e.actor, e.targetId, e.metadata])).toEqual([['sleep', 'm1', { digest: DIGEST }]]);
  });

  it('under a dry run finds nothing, writes nothing and never opens the store', () => {
    const root = storeWithTombstone();
    const checks = lazyTombstoneChecks(path.join(root, 'no-store-here'), true);
    expect(checks.find('ta', DIGEST)).toBeNull();
    checks.audit(refusal('m1'));
    checks.close();
    expect(fs.existsSync(path.join(root, 'no-store-here'))).toBe(false);
  });

  it('an unused set of checks closes without ever opening the store', () => {
    const root = storeWithTombstone();
    lazyTombstoneChecks(path.join(root, 'no-store-here'), false).close();
    expect(fs.existsSync(path.join(root, 'no-store-here'))).toBe(false);
  });
});
