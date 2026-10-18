import { describe, it, expect } from 'vitest';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

describe('store roundtrip with tenant_id', () => {
  it('writeEntry persists tenant_id, readEntry returns it', () => {
    const home = makeRoot('store-tenant');
    const entry = createMemory('tenant test content', { tenantId: 'acme' });
    writeEntry(home, entry);
    const loaded = readEntry(home, entry.id);
    expect(loaded?.tenant_id).toBe('acme');
  });

  it('omitting tenantId defaults to "default" on read', () => {
    const home = makeRoot('store-tenant');
    const entry = createMemory('no tenant content');
    writeEntry(home, entry);
    const loaded = readEntry(home, entry.id);
    expect(loaded?.tenant_id).toBe('default');
  });
});
