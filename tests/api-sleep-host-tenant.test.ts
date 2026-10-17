/**
 * D2 v1.12.10 — api.sleep emits consolidate audit row tagged with __host__
 * synthetic tenant (not ctx.tenantId).
 *
 * Closes the v1.11.4 Episode B independent-review-critic MED #3 and the
 * v1.12.0 sub-2 TODOS "Consolidate audit row tenant tag" item.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sleep, adminActor } from '../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

describe('api.sleep audit row tenant tag', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('d2-host-tenant');
  });

  it('emits consolidate audit row with tenant_id="__host__" (not ctx.tenantId)', async () => {
    const ctx = apiCtx(root, 'acme', adminActor('cli:operator-alice'));
    await sleep(ctx, { dryRun: true });

    const db = openHippoDb(root);
    try {
      // SAFETY: query selects exactly these four audit_log text columns, so
      // each returned row is shaped { tenant_id, actor, op, metadata_json }.
      const rows = db
        .prepare(`SELECT tenant_id, actor, op, metadata_json FROM audit_log WHERE op = 'consolidate'`)
        .all() as Array<{ tenant_id: string; actor: string; op: string; metadata_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe('__host__'); // D2 pick: host-wide tag
      expect(rows[0]!.actor).toBe('cli:operator-alice'); // operator still traceable
      const meta = JSON.parse(rows[0]!.metadata_json);
      expect(meta.triggeredByTenant).toBe('acme'); // forensics: which tenant called it
      expect(meta.dryRun).toBe(true);
      expect(meta.partial).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('multiple sleeps from different tenants all tag __host__ (host-wide is honest)', async () => {
    await sleep(
      apiCtx(root, 'acme', adminActor('cli:alice')),
      { dryRun: true },
    );
    await sleep(
      apiCtx(root, 'globex', adminActor('cli:bob')),
      { dryRun: true },
    );

    const db = openHippoDb(root);
    try {
      // SAFETY: query selects exactly these three audit_log text columns, so
      // each returned row is shaped { tenant_id, actor, metadata_json }.
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

});
