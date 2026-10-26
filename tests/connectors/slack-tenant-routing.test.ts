import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { resolveTenant, type RouteFallback } from '../../src/surface/connectors/tenant-route.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { envTenant } from '../../src/base/util/env.js';

// The webhook root's fallback, read at each call so a stubbed HIPPO_TENANT applies.
const fallback = (allowUnknown = false): RouteFallback => ({
  hostTenant: envTenant(),
  allowUnknown,
});

describe('resolveTenant', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('slack-tenant');
  });

  it('returns the mapped tenant_id when a row exists', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TTEAM1', 'tenant-alpha', new Date().toISOString());
      expect(
        await resolveTenant(
          sqliteStore(root),
          { connector: 'slack', teamId: 'TTEAM1' },
          fallback(),
        ),
      ).toBe('tenant-alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('matches team_id exactly (no prefix bleed); fails closed on unknown when workspaces non-empty', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TTEAM', 'tenant-short', new Date().toISOString());
      // Prefix-extended id must NOT match — fail closed (workspaces non-empty).
      expect(
        await resolveTenant(
          sqliteStore(root),
          { connector: 'slack', teamId: 'TTEAMX' },
          fallback(),
        ),
      ).toBeNull();
      // Substring must NOT match — fail closed.
      expect(
        await resolveTenant(sqliteStore(root), { connector: 'slack', teamId: 'TTEA' }, fallback()),
      ).toBeNull();
      // Exact still works.
      expect(
        await resolveTenant(sqliteStore(root), { connector: 'slack', teamId: 'TTEAM' }, fallback()),
      ).toBe('tenant-short');
    } finally {
      closeHippoDb(db);
    }
  });
});
