/**
 * E2 incident first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-29-e2-incident-object.md
 *
 * Covers:
 * 1. saveIncident creates both the memory mirror and the incidents row
 * 2. saveIncident without context: bare memory content, has_context false
 * 3. SAVEPOINT atomicity: writeEntry afterWrite throw rolls back BOTH
 * 4. resolveIncident flips open -> resolved + emits incident_resolve audit
 * 5. resolve CAS: re-resolving an already-resolved row throws not-open
 * 6. resolveIncident requires non-empty resolution text
 * 7. closeIncident flips open -> closed + emits incident_close audit
 * 8. closeIncident also works from resolved (resolved -> closed)
 * 9. close guard: not-found vs already-closed
 * 10. cross-tenant INSERT trigger raises ABORT (memory tenant mismatch)
 * 11. ON DELETE SET NULL: forget the memory, incident survives
 * 12. loadIncidents status filter; loadOpenIncidents excludes non-open
 * 13. loadIncidents rejects an invalid status
 * 14. linked_memory_ids round-trip + cross-tenant/nonexistent rejection (mandatory)
 * 15. tenant scoping: cross-tenant load returns empty
 * 16. schema v31 produces incidents table + triggers + indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  deleteEntry,
  writeEntry,
} from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  saveIncident,
  resolveIncident,
  closeIncident,
  loadIncidentById,
  loadIncidents,
  loadOpenIncidents,
  resolveActiveIncidentIdByMemory,
  VALID_INCIDENT_STATES,
} from '../src/incidents.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally { closeHippoDb(db); }
}

/** Write a plain memory and return its id (used to seed linked receipts). */
function seedMemory(home: string, content: string, tenantId: string): string {
  const mem = createMemory(content, {
    tags: ['note'],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'manual',
    tenantId,
  });
  writeEntry(home, mem);
  return mem.id;
}

describe('incidents store (E2 first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('incidents'); });
  afterEach(() => safeRmSync(home));

  it('saveIncident creates both memory and incidents row + incident_open audit', () => {
    const inc = saveIncident(home, 'default', {
      incidentText: 'DB pool exhausted',
      context: 'spike at 14:00',
    });
    expect(inc.id).toBeGreaterThan(0);
    expect(inc.memoryId).not.toBeNull();
    expect(inc.tenantId).toBe('default');
    expect(inc.incidentText).toBe('DB pool exhausted');
    expect(inc.context).toBe('spike at 14:00');
    expect(inc.status).toBe('open');
    expect(inc.resolutionText).toBeNull();
    expect(inc.resolvedAt).toBeNull();
    expect(inc.closedAt).toBeNull();
    expect(inc.linkedMemoryIds).toEqual([]);

    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, tags_json, source FROM memories WHERE id = ?`)
        .get(inc.memoryId!) as { content: string; tags_json: string; source: string } | undefined;
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('DB pool exhausted');
      expect(memRow!.content).toContain('Context: spike at 14:00');
      expect(memRow!.source).toBe('incident');
      expect((JSON.parse(memRow!.tags_json) as string[])).toContain('incident');

      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'incident_open' AND target_id = ?`)
        .all(String(inc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { incident_id: number; has_context: boolean };
      expect(meta.has_context).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveIncident without context: bare memory content, has_context false', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'cron job silently failed' });
    expect(inc.context).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(inc.memoryId!) as { content: string };
      expect(memRow.content).toBe('cron job silently failed');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'incident_open' AND target_id = ?`)
        .all(String(inc.id)) as Array<{ metadata_json: string }>;
      expect((JSON.parse(rows[0].metadata_json) as { has_context: boolean }).has_context).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both memory and incidents row', () => {
    const memBefore = countRows(home, 'memories');
    const incBefore = countRows(home, 'incidents');

    const mem = createMemory('throwing incident', {
      tags: ['incident'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'incident',
      tenantId: 'default',
    });
    expect(() => {
      writeEntry(home, mem, {
        afterWrite: () => { throw new Error('forced afterWrite failure'); },
      });
    }).toThrow('forced afterWrite failure');

    expect(countRows(home, 'memories')).toBe(memBefore);
    expect(countRows(home, 'incidents')).toBe(incBefore);
  });

  it('resolveIncident flips open -> resolved + emits incident_resolve audit', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'API 500s' });
    const resolved = resolveIncident(home, 'default', inc.id, 'restarted the worker pool');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionText).toBe('restarted the worker pool');
    expect(resolved.resolvedAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'incident_resolve' AND target_id = ?`)
        .all(String(inc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('resolve CAS: re-resolving an already-resolved incident throws not-open', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'resolve twice' });
    resolveIncident(home, 'default', inc.id, 'first resolution');
    expect(() => resolveIncident(home, 'default', inc.id, 'second resolution')).toThrow(/not open/);
    // not found when the id does not exist
    expect(() => resolveIncident(home, 'default', 88888, 'nope')).toThrow(/not found/);
  });

  it('resolveIncident requires a non-empty resolution text', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'needs resolution' });
    expect(() => resolveIncident(home, 'default', inc.id, '   ')).toThrow(/resolutionText is required/);
    // The failed resolve left the incident open.
    expect(loadIncidentById(home, 'default', inc.id)!.status).toBe('open');
  });

  it('closeIncident flips open -> closed + emits incident_close audit', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'close from open' });
    const closed = closeIncident(home, 'default', inc.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op = 'incident_close' AND target_id = ?`)
        .all(String(inc.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('closeIncident works from resolved (resolved -> closed)', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'resolve then close' });
    resolveIncident(home, 'default', inc.id, 'fixed root cause');
    const closed = closeIncident(home, 'default', inc.id);
    expect(closed.status).toBe('closed');
    // resolution data is preserved through the close.
    expect(closed.resolutionText).toBe('fixed root cause');
    expect(closed.closedAt).not.toBeNull();
  });

  it('close guard: not-found and already-closed error clearly', () => {
    expect(() => closeIncident(home, 'default', 77777)).toThrow(/not found/);

    const inc = saveIncident(home, 'default', { incidentText: 'close twice' });
    closeIncident(home, 'default', inc.id);
    expect(() => closeIncident(home, 'default', inc.id)).toThrow(/already closed/);
  });

  it('cross-tenant INSERT trigger raises ABORT on memory tenant mismatch', () => {
    const mem = createMemory('tenant-a memory', {
      tags: ['incident'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'incident',
      tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`
          INSERT INTO incidents(memory_id, tenant_id, incident_text, status, created_at)
          VALUES (?, 'tenant-b', 'cross-tenant attempt', 'open', ?)
        `).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the incident', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'survives memory decay' });
    expect(inc.memoryId).not.toBeNull();
    deleteEntry(home, inc.memoryId!, 'default');
    const reloaded = loadIncidentById(home, 'default', inc.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.memoryId).toBeNull();
    expect(reloaded!.status).toBe('open');
    expect(reloaded!.incidentText).toBe('survives memory decay');
    const open = loadOpenIncidents(home, 'default');
    expect(open.some((x) => x.id === inc.id)).toBe(true);
  });

  it('loadIncidents status filter; loadOpenIncidents excludes non-open', () => {
    const a = saveIncident(home, 'default', { incidentText: 'open-1' });
    const b = saveIncident(home, 'default', { incidentText: 'to-resolve' });
    const c = saveIncident(home, 'default', { incidentText: 'to-close' });
    resolveIncident(home, 'default', b.id, 'fixed');
    closeIncident(home, 'default', c.id);

    const open = loadOpenIncidents(home, 'default');
    expect(open.every((x) => x.status === 'open')).toBe(true);
    expect(open.some((x) => x.id === a.id)).toBe(true);
    expect(open.some((x) => x.id === b.id)).toBe(false);
    expect(open.some((x) => x.id === c.id)).toBe(false);

    const resolved = loadIncidents(home, 'default', { status: 'resolved' });
    expect(resolved.length).toBe(1);
    expect(resolved[0].id).toBe(b.id);

    const closed = loadIncidents(home, 'default', { status: 'closed' });
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(c.id);

    const all = loadIncidents(home, 'default');
    expect(all.length).toBe(3);
  });

  it('loadIncidents rejects an invalid status', () => {
    expect(() => {
      // @ts-expect-error — runtime validation test
      loadIncidents(home, 'default', { status: 'retired' });
    }).toThrow(/status must be one of/);
    expect(VALID_INCIDENT_STATES.has('open')).toBe(true);
    expect(VALID_INCIDENT_STATES.has('resolved')).toBe(true);
    expect(VALID_INCIDENT_STATES.has('closed')).toBe(true);
  });

  it('linked_memory_ids round-trips; cross-tenant/nonexistent ids are rejected', () => {
    const receiptA = seedMemory(home, 'evidence one', 'default');
    const receiptB = seedMemory(home, 'evidence two', 'default');
    const inc = saveIncident(home, 'default', {
      incidentText: 'with receipts',
      linkedMemoryIds: [receiptA, receiptB],
    });
    expect(inc.linkedMemoryIds).toEqual([receiptA, receiptB]);
    // Round-trips through a fresh load (parsed back from JSON text).
    const reloaded = loadIncidentById(home, 'default', inc.id);
    expect(reloaded!.linkedMemoryIds).toEqual([receiptA, receiptB]);

    // A nonexistent id is rejected, and the whole write rolls back.
    const incBefore = countRows(home, 'incidents');
    const memBefore = countRows(home, 'memories');
    expect(() => {
      saveIncident(home, 'default', {
        incidentText: 'bad receipt',
        linkedMemoryIds: ['mem_does_not_exist'],
      });
    }).toThrow(/linked memory .* not found/);
    expect(countRows(home, 'incidents')).toBe(incBefore);
    expect(countRows(home, 'memories')).toBe(memBefore);

    // A receipt belonging to another tenant is rejected (cross-tenant leak guard).
    const crossTenantReceipt = seedMemory(home, 'tenant-b evidence', 'tenant-b');
    expect(() => {
      saveIncident(home, 'default', {
        incidentText: 'cross-tenant receipt',
        linkedMemoryIds: [crossTenantReceipt],
      });
    }).toThrow(/linked memory .* not found/);
  });

  it('resolveActiveIncidentIdByMemory: row id for open, null for resolved/closed', () => {
    const inc = saveIncident(home, 'default', { incidentText: 'open one' });
    expect(resolveActiveIncidentIdByMemory(home, 'default', inc.memoryId!)).toBe(inc.id);

    resolveIncident(home, 'default', inc.id, 'fixed');
    expect(resolveActiveIncidentIdByMemory(home, 'default', inc.memoryId!)).toBeNull();
  });

  it('tenant scoping: cross-tenant load returns empty', () => {
    saveIncident(home, 'tenant-a', { incidentText: 'a-inc' });
    saveIncident(home, 'tenant-b', { incidentText: 'b-inc' });
    expect(loadIncidents(home, 'tenant-a').length).toBe(1);
    expect(loadIncidents(home, 'tenant-b').length).toBe(1);
    expect(loadIncidents(home, 'tenant-c').length).toBe(0);
    const a = loadIncidents(home, 'tenant-a')[0];
    expect(loadIncidentById(home, 'tenant-b', a.id)).toBeNull();
  });

  it('schema v31 produces incidents table + triggers + indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='incidents'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_incidents_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_incidents_tenant_match_insert');
      expect(triggers).toContain('trg_incidents_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_incidents_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_incidents_tenant_status');
      expect(indexes).toContain('idx_incidents_memory');
    } finally { closeHippoDb(db); }
  });
});
