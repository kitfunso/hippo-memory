import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { resolveTenantForSlackTeam } from '../src/connectors/slack/tenant-routing.js';

describe('resolveTenantForSlackTeam', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-tenant-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the mapped tenant_id when a row exists', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TTEAM1', 'tenant-alpha', new Date().toISOString());
      expect(await resolveTenantForSlackTeam(root, 'TTEAM1')).toBe('tenant-alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('falls back to env tenant when slack_workspaces is empty (single-workspace install)', async () => {
    const db = openHippoDb(root);
    const prev = process.env.HIPPO_TENANT;
    process.env.HIPPO_TENANT = 'env-tenant';
    try {
      // v0.39 fail-closed contract: empty slack_workspaces means single-
      // workspace install, env fallback is safe.
      expect(await resolveTenantForSlackTeam(root, 'TANY')).toBe('env-tenant');
    } finally {
      if (prev === undefined) delete process.env.HIPPO_TENANT;
      else process.env.HIPPO_TENANT = prev;
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
      expect(await resolveTenantForSlackTeam(root, 'TTEAMX')).toBeNull();
      // Substring must NOT match — fail closed.
      expect(await resolveTenantForSlackTeam(root, 'TTEA')).toBeNull();
      // Exact still works.
      expect(await resolveTenantForSlackTeam(root, 'TTEAM')).toBe('tenant-short');
    } finally {
      closeHippoDb(db);
    }
  });
});
