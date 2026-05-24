/**
 * D2 v1.12.10 — api.sleep emits consolidate audit row tagged with __host__
 * synthetic tenant (not ctx.tenantId).
 *
 * Closes the v1.11.4 Episode B independent-review-critic MED #3 and the
 * v1.12.0 sub-2 TODOS "Consolidate audit row tenant tag" item.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { sleep, adminActor } from '../src/api.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('api.sleep audit row tenant tag (D2 v1.12.10)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-d2-host-tenant-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits consolidate audit row with tenant_id="__host__" (not ctx.tenantId)', async () => {
    const ctx = {
      hippoRoot: root,
      tenantId: 'acme', // intentionally non-default to make sure __host__ wins
      actor: adminActor('cli:operator-alice'),
    };
    await sleep(ctx, { dryRun: true });

    const db = openHippoDb(root);
    try {
      const rows = db
        .prepare(`SELECT tenant_id, actor, op, metadata_json FROM audit_log WHERE op = 'consolidate'`)
        .all() as Array<{ tenant_id: string; actor: string; op: string; metadata_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe('__host__'); // D2 pick: host-wide tag
      expect(rows[0]!.actor).toBe('cli:operator-alice'); // operator still traceable
      const meta = JSON.parse(rows[0]!.metadata_json);
      expect(meta.triggeredByTenant).toBe('acme'); // forensics: which tenant called it
      expect(meta.dryRun).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('multiple sleeps from different tenants all tag __host__ (host-wide is honest)', async () => {
    await sleep(
      { hippoRoot: root, tenantId: 'acme', actor: adminActor('cli:alice') },
      { dryRun: true },
    );
    await sleep(
      { hippoRoot: root, tenantId: 'globex', actor: adminActor('cli:bob') },
      { dryRun: true },
    );

    const db = openHippoDb(root);
    try {
      const rows = db
        .prepare(`SELECT tenant_id, actor, metadata_json FROM audit_log WHERE op = 'consolidate' ORDER BY id`)
        .all() as Array<{ tenant_id: string; actor: string; metadata_json: string }>;
      expect(rows).toHaveLength(2);
      // BOTH rows tagged __host__ (host-wide work, not the caller's tenant).
      expect(rows[0]!.tenant_id).toBe('__host__');
      expect(rows[1]!.tenant_id).toBe('__host__');
      // But triggeredByTenant + actor preserve the forensic trail.
      expect(JSON.parse(rows[0]!.metadata_json).triggeredByTenant).toBe('acme');
      expect(rows[0]!.actor).toBe('cli:alice');
      expect(JSON.parse(rows[1]!.metadata_json).triggeredByTenant).toBe('globex');
      expect(rows[1]!.actor).toBe('cli:bob');
    } finally {
      closeHippoDb(db);
    }
  });

  it('consolidate rows are visible to `hippo audit list --tenant __host__`', async () => {
    await sleep(
      { hippoRoot: root, tenantId: 'acme', actor: adminActor('cli:alice') },
      { dryRun: true },
    );

    // Tenant-A admin running default `hippo audit list` would NOT see this row
    // (tenant filter is 'acme'). Querying the synthetic __host__ tenant
    // surfaces it.
    const db = openHippoDb(root);
    try {
      const acmeRows = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE op = 'consolidate' AND tenant_id = ?`)
        .get('acme') as { c: number | bigint };
      expect(Number(acmeRows.c)).toBe(0); // tenant view doesn't show host ops

      const hostRows = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE op = 'consolidate' AND tenant_id = ?`)
        .get('__host__') as { c: number | bigint };
      expect(Number(hostRows.c)).toBe(1); // host view shows them
    } finally {
      closeHippoDb(db);
    }
  });
});
