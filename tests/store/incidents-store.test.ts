/**
 * E2 incident first-class object — store-layer tests.
 * Docs: docs/plans/2026-05-29-e2-incident-object.md
 *
 * Covers what only incidents have; the rules every kind shares run per kind in typed-object-store.test.ts.
 * 1. saveIncident creates both the memory mirror and the incidents row
 * 2. saveIncident without context: bare memory content, has_context false
 * 3. resolveIncident flips open -> resolved + emits incident_resolve audit
 * 4. resolve CAS: re-resolving an already-resolved row throws not-open
 * 5. resolveIncident requires non-empty resolution text
 * 6. closeIncident flips open -> closed + emits incident_close audit
 * 7. closeIncident also works from resolved (resolved -> closed)
 * 8. close guard: not-found vs already-closed
 * 9. ON DELETE SET NULL: forget the memory, incident survives
 * 10. loadIncidents status filter; status 'open' excludes non-open
 * 11. linked_memory_ids round-trip + cross-tenant/nonexistent rejection (mandatory)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../../src/store/entry-writes.js';
import { Layer} from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  openIncident,
  resolveOpenIncident,
  closeIncident,
  loadIncidentById,
  loadIncidents,
} from '../../src/objects/incidents.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/core/config.js';
import { deleteEntry } from '../_helpers/root-forms.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Query a single row from the hippo SQLite handle. */
function queryOne<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Query all rows from the hippo SQLite handle. */
function queryAll<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T[] {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).all(...params) as T[];
}

function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: table is always one of this test file's own literal SQL
    // identifiers ('memories' | 'incidents'), never external input.
    return (queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM ${table}`))!.c;
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

describe('incidents store (first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('incidents'); });
  afterEach(() => safeRmSync(home));

  it('saveIncident creates both memory and incidents row + incident_open audit', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      incidentText: 'DB pool exhausted',
      context: 'spike at 14:00',
    }, 'cli');
    // The first row of a fresh AUTOINCREMENT table.
    expect(inc.id).toBe(1);
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
      const memRow = queryOne<{ content: string; tags_json: string; source: string }>(
        db,
        `SELECT content, tags_json, source FROM memories WHERE id = ?`,
        inc.memoryId!,
      );
      expect(memRow).toBeDefined();
      expect(memRow!.content).toContain('DB pool exhausted');
      expect(memRow!.content).toContain('Context: spike at 14:00');
      expect(memRow!.source).toBe('incident');
      // SAFETY: tags_json is this test's own row, written by saveIncident as a
      // JSON.stringify'd string[] (memory tags column).
      expect(JSON.parse(memRow!.tags_json) as string[]).toContain('incident');

      const rows = queryAll<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'incident_open' AND target_id = ?`,
        String(inc.id),
      );
      expect(rows.length).toBe(1);
      // SAFETY: metadata_json is this test's own audit row, written by
      // saveIncident's incident_open audit call with this exact shape.
      const meta = JSON.parse(rows[0].metadata_json) as { incident_id: number; has_context: boolean };
      expect(meta.has_context).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveIncident without context: bare memory content, has_context false', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'cron job silently failed' }, 'cli');
    expect(inc.context).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = queryOne<{ content: string }>(
        db,
        `SELECT content FROM memories WHERE id = ?`,
        inc.memoryId!,
      );
      expect(memRow!.content).toBe('cron job silently failed');
      const rows = queryAll<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'incident_open' AND target_id = ?`,
        String(inc.id),
      );
      // SAFETY: metadata_json is this test's own audit row, written by
      // saveIncident's incident_open audit call with this exact shape.
      expect((JSON.parse(rows[0].metadata_json) as { has_context: boolean }).has_context).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('resolveIncident flips open -> resolved + emits incident_resolve audit', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'API 500s' }, 'cli');
    const resolved = await resolveOpenIncident(objectsAt(home), 'default', inc.id, 'restarted the worker pool', 'cli');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionText).toBe('restarted the worker pool');
    expect(resolved.resolvedAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = queryAll<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'incident_resolve' AND target_id = ?`,
        String(inc.id),
      );
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('resolve CAS: re-resolving an already-resolved incident throws not-open', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'resolve twice' }, 'cli');
    await resolveOpenIncident(objectsAt(home), 'default', inc.id, 'first resolution', 'cli');
    await expect(resolveOpenIncident(objectsAt(home), 'default', inc.id, 'second resolution', 'cli')).rejects.toThrow(/not open/);
    // not found when the id does not exist
    await expect(resolveOpenIncident(objectsAt(home), 'default', 88888, 'nope', 'cli')).rejects.toThrow(/not found/);
  });

  it('resolveIncident requires a non-empty resolution text', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'needs resolution' }, 'cli');
    await expect(resolveOpenIncident(objectsAt(home), 'default', inc.id, '   ', 'cli')).rejects.toThrow(/resolutionText is required/);
    // The failed resolve left the incident open.
    expect((await loadIncidentById(objectsAt(home), 'default', inc.id))!.status).toBe('open');
  });

  it('closeIncident flips open -> closed + emits incident_close audit', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'close from open' }, 'cli');
    const closed = await closeIncident(objectsAt(home), 'default', inc.id);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const db = openHippoDb(home);
    try {
      const rows = queryAll<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op = 'incident_close' AND target_id = ?`,
        String(inc.id),
      );
      expect(rows.length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('closeIncident works from resolved (resolved -> closed)', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'resolve then close' }, 'cli');
    await resolveOpenIncident(objectsAt(home), 'default', inc.id, 'fixed root cause', 'cli');
    const closed = await closeIncident(objectsAt(home), 'default', inc.id);
    expect(closed.status).toBe('closed');
    // resolution data is preserved through the close.
    expect(closed.resolutionText).toBe('fixed root cause');
    expect(closed.closedAt).not.toBeNull();
  });

  it('close guard: not-found and already-closed error clearly', async () => {
    await expect(closeIncident(objectsAt(home), 'default', 77777)).rejects.toThrow(/not found/);

    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'close twice' }, 'cli');
    await closeIncident(objectsAt(home), 'default', inc.id);
    await expect(closeIncident(objectsAt(home), 'default', inc.id)).rejects.toThrow(/already closed/);
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the incident', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'survives memory decay' }, 'cli');
    expect(inc.memoryId).not.toBeNull();
    deleteEntry(home, inc.memoryId!);
    const reloaded = await loadIncidentById(objectsAt(home), 'default', inc.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.memoryId).toBeNull();
    expect(reloaded!.status).toBe('open');
    expect(reloaded!.incidentText).toBe('survives memory decay');
    const open = await loadIncidents(objectsAt(home), 'default', { status: 'open' });
    expect(open.some((x) => x.id === inc.id)).toBe(true);
  });

  it('loadIncidents status filter; status open excludes non-open', async () => {
    const a = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'open-1' }, 'cli');
    const b = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'to-resolve' }, 'cli');
    const c = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'to-close' }, 'cli');
    await resolveOpenIncident(objectsAt(home), 'default', b.id, 'fixed', 'cli');
    await closeIncident(objectsAt(home), 'default', c.id);

    const open = await loadIncidents(objectsAt(home), 'default', { status: 'open' });
    expect(open.every((x) => x.status === 'open')).toBe(true);
    expect(open.some((x) => x.id === a.id)).toBe(true);
    expect(open.some((x) => x.id === b.id)).toBe(false);
    expect(open.some((x) => x.id === c.id)).toBe(false);

    const resolved = await loadIncidents(objectsAt(home), 'default', { status: 'resolved' });
    expect(resolved.length).toBe(1);
    expect(resolved[0].id).toBe(b.id);

    const closed = await loadIncidents(objectsAt(home), 'default', { status: 'closed' });
    expect(closed.length).toBe(1);
    expect(closed[0].id).toBe(c.id);

    const all = await loadIncidents(objectsAt(home), 'default');
    expect(all.length).toBe(3);
  });

  it('linked_memory_ids round-trips; cross-tenant/nonexistent ids are rejected', async () => {
    const receiptA = seedMemory(home, 'evidence one', 'default');
    const receiptB = seedMemory(home, 'evidence two', 'default');
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      incidentText: 'with receipts',
      linkedMemoryIds: [receiptA, receiptB],
    }, 'cli');
    expect(inc.linkedMemoryIds).toEqual([receiptA, receiptB]);
    // Round-trips through a fresh load (parsed back from JSON text).
    const reloaded = await loadIncidentById(objectsAt(home), 'default', inc.id);
    expect(reloaded!.linkedMemoryIds).toEqual([receiptA, receiptB]);

    // A nonexistent id is rejected, and the whole write rolls back.
    const incBefore = countRows(home, 'incidents');
    const memBefore = countRows(home, 'memories');
    await expect(async () => {
      await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        incidentText: 'bad receipt',
        linkedMemoryIds: ['mem_does_not_exist'],
      }, 'cli');
    }).rejects.toThrow(/linked memory .* not found/);
    expect(countRows(home, 'incidents')).toBe(incBefore);
    expect(countRows(home, 'memories')).toBe(memBefore);

    // A receipt belonging to another tenant is rejected (cross-tenant leak guard).
    const crossTenantReceipt = seedMemory(home, 'tenant-b evidence', 'tenant-b');
    await expect(async () => {
      await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        incidentText: 'cross-tenant receipt',
        linkedMemoryIds: [crossTenantReceipt],
      }, 'cli');
    }).rejects.toThrow(/linked memory .* not found/);
  });

  it('objectIdByMemory: row id for an open incident, null for resolved/closed', async () => {
    const inc = await openIncident(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { incidentText: 'open one' }, 'cli');
    expect(await objectsAt(home).objectIdByMemory('default', 'incident', 'open', inc.memoryId!)).toBe(inc.id);

    await resolveOpenIncident(objectsAt(home), 'default', inc.id, 'fixed', 'cli');
    expect(await objectsAt(home).objectIdByMemory('default', 'incident', 'open', inc.memoryId!)).toBeNull();
  });
});
