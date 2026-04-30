import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { resolveTenantForTeam } from '../src/connectors/slack/tenant-routing.js';

describe('resolveTenantForTeam', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-tenant-'));
    initStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the mapped tenant_id when a row exists', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TTEAM1', 'tenant-alpha', new Date().toISOString());
      expect(resolveTenantForTeam(db, 'TTEAM1')).toBe('tenant-alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('falls back to env tenant when slack_workspaces is empty (single-workspace install)', () => {
    const db = openHippoDb(root);
    const prev = process.env.HIPPO_TENANT;
    process.env.HIPPO_TENANT = 'env-tenant';
    try {
      // v0.39 fail-closed contract: empty slack_workspaces means single-
      // workspace install, env fallback is safe.
      expect(resolveTenantForTeam(db, 'TANY')).toBe('env-tenant');
    } finally {
      if (prev === undefined) delete process.env.HIPPO_TENANT;
      else process.env.HIPPO_TENANT = prev;
      closeHippoDb(db);
    }
  });

  it('matches team_id exactly (no prefix bleed) — fails closed on unknown when workspaces non-empty', () => {
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('TTEAM', 'tenant-short', new Date().toISOString());
      // Prefix-extended id must NOT match — fail closed (workspaces non-empty).
      expect(resolveTenantForTeam(db, 'TTEAMX')).toBeNull();
      // Substring must NOT match — fail closed.
      expect(resolveTenantForTeam(db, 'TTEA')).toBeNull();
      // Exact still works.
      expect(resolveTenantForTeam(db, 'TTEAM')).toBe('tenant-short');
    } finally {
      closeHippoDb(db);
    }
  });
});
