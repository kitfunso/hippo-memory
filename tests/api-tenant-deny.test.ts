import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember, forget, archiveRaw } from '../src/api.js';

// Regression: archiveRaw and forget previously looked up the target row by
// id alone, with no tenant filter. A valid Bearer for tenant A could
// archive or delete tenant B's row by guessing or leaking the id. Both
// paths now pre-check tenant_id and throw a not-found error on mismatch
// (same shape as the missing-row error, no info leak).

describe('api tenant deny — archiveRaw and forget', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-tenant-deny-'));
    initStore(home);
  });

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('archiveRaw refuses to archive a row that belongs to another tenant', () => {
    // Tenant A creates a kind='raw' memory.
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'raw-row-from-alpha tenant-deny canary', kind: 'raw' },
    );

    // Tenant B (bravo) tries to archive it. Should fail with not-found.
    expect(() =>
      archiveRaw(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
        'cross-tenant probe',
      ),
    ).toThrow(/memory not found/i);

    // Original row must still exist with its kind intact.
    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id, kind FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string; kind: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.kind).toBe('raw');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget refuses to delete a row that belongs to another tenant', () => {
    // Tenant A creates a kind='distilled' memory.
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'distilled-row-from-alpha tenant-deny canary', kind: 'distilled' },
    );

    // Tenant B tries to forget it.
    expect(() =>
      forget(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
      ),
    ).toThrow(/memory not found/i);

    // Original row must still exist.
    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget still works for the owning tenant', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'owning-tenant forget happy-path' },
    );
    const result = forget(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      created.id,
    );
    expect(result.ok).toBe(true);

    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT id FROM memories WHERE id = ?`)
        .get(created.id) as { id?: string } | undefined;
      expect(row).toBeUndefined();
    } finally {
      closeHippoDb(db);
    }
  });
});
