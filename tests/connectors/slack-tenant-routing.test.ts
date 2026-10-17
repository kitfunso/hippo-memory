import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { resolveTenantForSlackTeam } from '../../src/connectors/slack/tenant-routing.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('resolveTenantForSlackTeam', () => {
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
      expect(await resolveTenantForSlackTeam(sqliteStore(root), 'TTEAM1')).toBe('tenant-alpha');
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
      expect(await resolveTenantForSlackTeam(sqliteStore(root), 'TTEAMX')).toBeNull();
      // Substring must NOT match — fail closed.
      expect(await resolveTenantForSlackTeam(sqliteStore(root), 'TTEA')).toBeNull();
      // Exact still works.
      expect(await resolveTenantForSlackTeam(sqliteStore(root), 'TTEAM')).toBe('tenant-short');
    } finally {
      closeHippoDb(db);
    }
  });
});
