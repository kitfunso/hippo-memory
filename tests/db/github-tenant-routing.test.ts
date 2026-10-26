import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { resolveTenant, type RouteFallback } from '../../src/surface/connectors/tenant-route.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { envTenant } from '../../src/base/util/env.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

// The webhook root's fallback, read at each call so a stubbed HIPPO_TENANT applies.
const fallback = (allowUnknown = false): RouteFallback => ({
  hostTenant: envTenant(),
  allowUnknown,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function insertInstallation(db: DatabaseSyncLike, id: string, tenant: string): void {
  db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
    id,
    tenant,
    new Date().toISOString(),
  );
}

function insertRepository(
  db: DatabaseSyncLike,
  repoFullName: string,
  tenant: string,
  addedAt: string = new Date().toISOString(),
): void {
  db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)`).run(
    repoFullName,
    tenant,
    addedAt,
  );
}

describe('resolveTenant', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('github-tenant');
    vi.stubEnv('HIPPO_TENANT', undefined);
    vi.stubEnv('GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK', undefined);
  });

  afterEach(() => {
    removeAfterRequest(root);
  });

  it('rule 1: installation_id matches a row -> returns mapped tenant', async () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github', installationId: '12345' }, fallback())).toBe(
        'tenant-alpha',
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 2: installation_id present, table non-empty, no row -> returns null', async () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      // Unknown installation id, table non-empty -> fail closed.
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: '99999',
            repoFullName: 'foo/bar',
          },
          fallback(),
        ),
      ).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 3: no installation_id, both tables empty -> returns env fallback (HIPPO_TENANT)', async () => {
    const db = openHippoDb(root);
    try {
      vi.stubEnv('HIPPO_TENANT', 'env-tenant');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBe('env-tenant');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github', repoFullName: 'foo/bar' }, fallback())).toBe(
        'env-tenant',
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it("rule 3 default: no installation_id, both tables empty, no HIPPO_TENANT -> 'default'", async () => {
    const db = openHippoDb(root);
    try {
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBe('default');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github', repoFullName: 'foo/bar' }, fallback())).toBe(
        'default',
      );
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 4: no installation_id, github_repositories has matching row -> returns that tenant (PAT-mode)', async () => {
    const db = openHippoDb(root);
    try {
      insertRepository(db, 'octo/widget', 'tenant-pat');
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: null,
            repoFullName: 'octo/widget',
          },
          fallback(),
        ),
      ).toBe('tenant-pat');
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 5: no installation_id, github_installations non-empty, no repo match -> returns null', async () => {
    const db = openHippoDb(root);
    try {
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: null,
            repoFullName: 'unknown/repo',
          },
          fallback(),
        ),
      ).toBeNull();
      // Even with no repoFullName supplied — PAT-mode envelope from a foreign source.
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 5 variant: no installation_id, github_repositories non-empty, no repo match -> returns null', async () => {
    const db = openHippoDb(root);
    try {
      insertRepository(db, 'octo/widget', 'tenant-pat');
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: null,
            repoFullName: 'unknown/repo',
          },
          fallback(),
        ),
      ).toBeNull();
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 6: escape hatch via env var, with mismatch -> returns env fallback', async () => {
    const db = openHippoDb(root);
    try {
      vi.stubEnv('HIPPO_TENANT', 'rollback-tenant');
      // Case 2: installation_id present but unknown.
      insertInstallation(db, '12345', 'tenant-alpha');
      expect(
        await resolveTenant(sqliteStore(root), { connector: 'github', installationId: '99999' }, fallback(true)),
      ).toBe('rollback-tenant');
      // Case 5: no installation_id, no repo match.
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: null,
            repoFullName: 'unknown/repo',
          },
          fallback(true),
        ),
      ).toBe('rollback-tenant');
    } finally {
      closeHippoDb(db);
    }
  });

  it('regression: PAT-mode webhook (no installation_id) with non-empty github_installations and no repo match -> null', async () => {
    const db = openHippoDb(root);
    try {
      // Multi-tenant App install populated via installations table.
      insertInstallation(db, '11111', 'tenant-alpha');
      insertInstallation(db, '22222', 'tenant-beta');
      // Foreign PAT-mode webhook arrives — no installation field, repo not registered.
      // The pre-fix bug was: env fallback fires here, silently routing into HIPPO_TENANT.
      // Post-fix: must fail closed.
      vi.stubEnv('HIPPO_TENANT', 'env-tenant');
      expect(
        await resolveTenant(
          sqliteStore(root),
          {
            connector: 'github',
            installationId: null,
            repoFullName: 'foreign/repo',
          },
          fallback(),
        ),
      ).toBeNull();
      // Even with no repoFullName at all (malformed PAT-mode envelope).
      expect(
        await resolveTenant(sqliteStore(root), { connector: 'github', installationId: undefined }, fallback()),
      ).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('rule 4 shared name: two tenants registered the repository -> null, with a warn naming both', async () => {
    const db = openHippoDb(root);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      insertRepository(db, 'shared/tool', 'tenant-zulu', '2026-01-02T00:00:00.000Z');
      insertRepository(db, 'shared/tool', 'tenant-alpha', '2026-01-01T00:00:00.000Z');
      const query = { connector: 'github', installationId: null, repoFullName: 'shared/tool' } as const;
      expect(await resolveTenant(sqliteStore(root), query, fallback())).toBeNull();
      const warned = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('two tenants registered'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('repo=shared/tool tenants=tenant-alpha,tenant-zulu');
    } finally {
      stderr.mockRestore();
      closeHippoDb(db);
    }
  });

  it('HIPPO_TENANT env var set -> uses it; cleared -> falls back to "default"', async () => {
    const db = openHippoDb(root);
    try {
      // Both tables empty -> single-tenant deployment, env fallback path.
      vi.stubEnv('HIPPO_TENANT', 'custom-env');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBe('custom-env');
      // Whitespace-only HIPPO_TENANT must fall back to 'default'.
      vi.stubEnv('HIPPO_TENANT', '   ');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBe('default');
      // Cleared.
      vi.stubEnv('HIPPO_TENANT', undefined);
      expect(await resolveTenant(sqliteStore(root), { connector: 'github' }, fallback())).toBe('default');
    } finally {
      closeHippoDb(db);
    }
  });

  it('installation_id present, both tables empty -> env fallback (single-tenant deployment with App webhook)', async () => {
    const db = openHippoDb(root);
    try {
      vi.stubEnv('HIPPO_TENANT', 'env-tenant');
      expect(await resolveTenant(sqliteStore(root), { connector: 'github', installationId: '12345' }, fallback())).toBe(
        'env-tenant',
      );
    } finally {
      closeHippoDb(db);
    }
  });
});
