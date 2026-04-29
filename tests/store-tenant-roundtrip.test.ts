import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

describe('store roundtrip with tenant_id', () => {
  it('writeEntry persists tenant_id, readEntry returns it', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-store-tenant-'));
    try {
      initStore(home);
      const entry = createMemory('tenant test content', { tenantId: 'acme' });
      writeEntry(home, entry);
      const loaded = readEntry(home, entry.id);
      expect(loaded?.tenantId).toBe('acme');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('omitting tenantId defaults to "default" on read', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-store-tenant-'));
    try {
      initStore(home);
      const entry = createMemory('no tenant content');
      writeEntry(home, entry);
      const loaded = readEntry(home, entry.id);
      expect(loaded?.tenantId).toBe('default');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
