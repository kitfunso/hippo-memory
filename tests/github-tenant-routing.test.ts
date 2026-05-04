import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { resolveTenantForGitHub } from '../src/connectors/github/tenant-routing.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function insertInstallation(db: DatabaseSyncLike, id: string, tenant: string): void {
  db.prepare(
    `INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`,
  ).run(id, tenant, new Date().toISOString());
}

function insertRepository(
  db: DatabaseSyncLike,
  repoFullName: string,
  tenant: string,
  addedAt: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)`,
  ).run(repoFullName, tenant, addedAt);
}

describe('resolveTenantForGitHub', () => {
  let root: string;
  let prevHippoTenant: string | undefined;
  let prevEscapeHatch: string | undefined;

  beforeEach(() => {
    root = makeRoot('github-tenant');
    prevHippoTenant = process.env.HIPPO_TENANT;
    prevEscapeHatch = process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK;
    delete process.env.HIPPO_TENANT;
    delete process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK;
  });

  afterEach(() => {
    if (prevHippoTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = prevHippoTenant;
    if (prevEscapeHatch === undefined) delete process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK;
    else process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK = prevEscapeHatch;
    rmSync(root, { recursive: true, force: true });
  });

  it('rule 1: installation_id matches a row -> returns mapped tenant', () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(resolveTenantForGitHub(db, { installationId: '12345' })).toBe('tenant-alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 2: installation_id present, table non-empty, no row -> returns null', () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      // Unknown installation id, table non-empty -> fail closed.
      expect(
        resolveTenantForGitHub(db, { installationId: '99999', repoFullName: 'foo/bar' }),
      ).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 3: no installation_id, both tables empty -> returns env fallback (HIPPO_TENANT)', () => {
    const db = openHippoDb(root);
    try {
      process.env.HIPPO_TENANT = 'env-tenant';
      expect(resolveTenantForGitHub(db, {})).toBe('env-tenant');
      expect(resolveTenantForGitHub(db, { repoFullName: 'foo/bar' })).toBe('env-tenant');
    } finally {
      closeHippoDb(db);
    }
  });

  it("rule 3 default: no installation_id, both tables empty, no HIPPO_TENANT -> 'default'", () => {
    const db = openHippoDb(root);
    try {
      expect(resolveTenantForGitHub(db, {})).toBe('default');
      expect(resolveTenantForGitHub(db, { repoFullName: 'foo/bar' })).toBe('default');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 4: no installation_id, github_repositories has matching row -> returns that tenant (PAT-mode)', () => {
    const db = openHippoDb(root);
    try {
      insertRepository(db, 'octo/widget', 'tenant-pat');
      expect(
        resolveTenantForGitHub(db, { installationId: null, repoFullName: 'octo/widget' }),
      ).toBe('tenant-pat');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 5: no installation_id, github_installations non-empty, no repo match -> returns null', () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(
        resolveTenantForGitHub(db, { installationId: null, repoFullName: 'unknown/repo' }),
      ).toBeNull();
      // Even with no repoFullName supplied — PAT-mode envelope from a foreign source.
      expect(resolveTenantForGitHub(db, {})).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 5 variant: no installation_id, github_repositories non-empty, no repo match -> returns null', () => {
    const db = openHippoDb(root);
    try {
      insertRepository(db, 'octo/widget', 'tenant-pat');
      expect(
        resolveTenantForGitHub(db, { installationId: null, repoFullName: 'unknown/repo' }),
      ).toBeNull();
      expect(resolveTenantForGitHub(db, {})).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 6: escape hatch via env var, with mismatch -> returns env fallback', () => {
    const db = openHippoDb(root);
    try {
      process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK = '1';
      process.env.HIPPO_TENANT = 'rollback-tenant';
      // Case 2: installation_id present but unknown.
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(resolveTenantForGitHub(db, { installationId: '99999' })).toBe('rollback-tenant');
      // Case 5: no installation_id, no repo match.
      expect(
        resolveTenantForGitHub(db, { installationId: null, repoFullName: 'unknown/repo' }),
      ).toBe('rollback-tenant');
    } finally {
      closeHippoDb(db);
    }
  });

  it('codex P0 #4 regression: PAT-mode webhook (no installation_id) with non-empty github_installations and no repo match -> null', () => {
    const db = openHippoDb(root);
    try {
      // Multi-tenant App install populated via installations table.
      insertInstallation(db, '11111', 'tenant-alpha');
      insertInstallation(db, '22222', 'tenant-beta');
      // Foreign PAT-mode webhook arrives — no installation field, repo not registered.
      // The pre-fix bug was: env fallback fires here, silently routing into HIPPO_TENANT.
      // Post-fix: must fail closed.
      process.env.HIPPO_TENANT = 'env-tenant';
      expect(
        resolveTenantForGitHub(db, {
          installationId: null,
          repoFullName: 'foreign/repo',
        }),
      ).toBeNull();
      // Even with no repoFullName at all (malformed PAT-mode envelope).
      expect(resolveTenantForGitHub(db, { installationId: undefined })).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 4 deterministic order: multiple tenants share a repo_full_name -> returns first by (added_at, tenant_id)', () => {
    const db = openHippoDb(root);
    try {
      // Insert in non-sorted order to prove ORDER BY is doing the work.
      insertRepository(db, 'shared/tool', 'tenant-zulu', '2026-01-02T00:00:00.000Z');
      insertRepository(db, 'shared/tool', 'tenant-alpha', '2026-01-01T00:00:00.000Z');
      insertRepository(db, 'shared/tool', 'tenant-bravo', '2026-01-01T00:00:00.000Z');
      // Earliest added_at wins; tie broken by tenant_id ascending -> 'tenant-alpha'.
      expect(
        resolveTenantForGitHub(db, { installationId: null, repoFullName: 'shared/tool' }),
      ).toBe('tenant-alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('HIPPO_TENANT env var set -> uses it; cleared -> falls back to "default"', () => {
    const db = openHippoDb(root);
    try {
      // Both tables empty -> single-tenant deployment, env fallback path.
      process.env.HIPPO_TENANT = 'custom-env';
      expect(resolveTenantForGitHub(db, {})).toBe('custom-env');
      // Whitespace-only HIPPO_TENANT must fall back to 'default'.
      process.env.HIPPO_TENANT = '   ';
      expect(resolveTenantForGitHub(db, {})).toBe('default');
      // Cleared.
      delete process.env.HIPPO_TENANT;
      expect(resolveTenantForGitHub(db, {})).toBe('default');
    } finally {
      closeHippoDb(db);
    }
  });

  it('installation_id present, both tables empty -> env fallback (single-tenant deployment with App webhook)', () => {
    const db = openHippoDb(root);
    try {
      process.env.HIPPO_TENANT = 'env-tenant';
      expect(resolveTenantForGitHub(db, { installationId: '12345' })).toBe('env-tenant');
    } finally {
      closeHippoDb(db);
    }
  });
});
