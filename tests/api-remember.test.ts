import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, readEntry } from '../src/store.js';
import { remember } from '../src/api.js';

describe('api.remember', () => {
  it('persists a memory and returns its envelope', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-api-rem-'));
    initStore(home);
    const result = remember({
      hippoRoot: home,
      tenantId: 'default',
      actor: 'cli',
    }, {
      content: 'api-canary-remember-77',
      kind: 'distilled',
    });
    expect(result.id).toMatch(/^mem_/);
    expect(result.kind).toBe('distilled');
    expect(result.tenantId).toBe('default');
    const stored = readEntry(home, result.id);
    expect(stored?.content).toBe('api-canary-remember-77');
    expect(stored?.tenantId).toBe('default');
    rmSync(home, { recursive: true, force: true });
  });

  it('emits an audit event with the supplied actor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-api-rem-'));
    initStore(home);
    remember(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_test' },
      { content: 'audit-trail-canary' },
    );
    const { openHippoDb, closeHippoDb } = await import('../src/db.js');
    const { queryAuditEvents } = await import('../src/audit.js');
    const db = openHippoDb(home);
    const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember' });
    // Task 4 dedupe: exactly one audit row, with the supplied actor.
    expect(events.length).toBe(1);
    expect(events[0]!.actor).toBe('api_key:hk_test');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
