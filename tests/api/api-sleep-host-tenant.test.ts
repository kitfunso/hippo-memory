import { describe, it, expect, beforeEach } from 'vitest';
import { sleepWholeStore, adminActor } from '../../src/api/index.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('api.sleep audit row tenant tag', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('d2-host-tenant');
  });

  it('emits consolidate audit row with tenant_id="__host__" (not ctx.tenantId)', async () => {
    const ctx = apiCtx(root, 'acme', adminActor('cli:operator-alice'));
    await sleepWholeStore(ctx, { dryRun: true });

    const db = openHippoDb(root);
    try {
      // SAFETY: query selects exactly these four audit_log text columns, so
      // each returned row is shaped { tenant_id, actor, op, metadata_json }.
      const rows = db
        .prepare(`SELECT tenant_id, actor, op, metadata_json FROM audit_log WHERE op = 'consolidate'`)
        .all() as Array<{ tenant_id: string; actor: string; op: string; metadata_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe('__host__');
      expect(rows[0]!.actor).toBe('cli:operator-alice');
      const meta = JSON.parse(rows[0]!.metadata_json);
      expect(meta.triggeredByTenant).toBe('acme');
      expect(meta.dryRun).toBe(true);
      expect(meta.partial).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('multiple sleeps from different tenants all tag __host__ (host-wide is honest)', async () => {
    await sleepWholeStore(apiCtx(root, 'acme', adminActor('cli:alice')), { dryRun: true });
    await sleepWholeStore(apiCtx(root, 'globex', adminActor('cli:bob')), { dryRun: true });

    const db = openHippoDb(root);
    try {
      // SAFETY: query selects exactly these three audit_log text columns, so
      // each returned row is shaped { tenant_id, actor, metadata_json }.
      const rows = db
        .prepare(`SELECT tenant_id, actor, metadata_json FROM audit_log WHERE op = 'consolidate' ORDER BY id`)
        .all() as Array<{ tenant_id: string; actor: string; metadata_json: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.tenant_id).toBe('__host__');
      expect(rows[1]!.tenant_id).toBe('__host__');
      expect(JSON.parse(rows[0]!.metadata_json).triggeredByTenant).toBe('acme');
      expect(rows[0]!.actor).toBe('cli:alice');
      expect(JSON.parse(rows[1]!.metadata_json).triggeredByTenant).toBe('globex');
      expect(rows[1]!.actor).toBe('cli:bob');
    } finally {
      closeHippoDb(db);
    }
  });
});
