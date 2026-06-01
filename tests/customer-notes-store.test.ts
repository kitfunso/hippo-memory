/**
 * E2 customer_note first-class object (entity-scoped) - store-layer tests.
 * Docs: docs/plans/2026-06-01-e2-customer-note-object.md
 *
 * Covers:
 * 1. saveCustomerNote creates memory + customer_notes row (+ create audit), v1
 * 2. memory mirror carries customer:<lc> tag (lowercased; colon-in-customer safe)
 * 3. SAVEPOINT atomicity
 * 4. supersede chain + version + change_summary + supersede audit
 * 5. supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight
 * 6. close + close guard (not-found; cannot-close-superseded; cannot re-close)
 * 7. cross-tenant INSERT trigger + supersede tenant-match trigger
 * 8. ON DELETE SET NULL + old version loadable
 * 9. status + customer filters; MANY notes per customer; loadActiveNotesForCustomer; invalid status
 * 10. validation: missing customer/note; single-line customer; caps
 * 11. schema v36 table + 3 triggers + 3 indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  saveCustomerNote,
  closeCustomerNote,
  loadCustomerNoteById,
  loadCustomerNotes,
  loadActiveNotesForCustomer,
  VALID_NOTE_STATES,
  MAX_NOTE_LEN,
} from '../src/customer-notes.js';

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
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c; }
  finally { closeHippoDb(db); }
}
function memTags(home: string, memoryId: string): string[] {
  const db = openHippoDb(home);
  try {
    const r = db.prepare(`SELECT tags_json FROM memories WHERE id = ?`).get(memoryId) as { tags_json: string };
    return JSON.parse(r.tags_json) as string[];
  } finally { closeHippoDb(db); }
}

describe('customer_notes store (E2 entity-scoped first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('customer-notes'); });
  afterEach(() => safeRmSync(home));

  it('saveCustomerNote creates memory + row + customer_note_create audit; v1', () => {
    const n = saveCustomerNote(home, 'default', { customer: 'Acme Corp', note: 'renewal call notes' });
    expect(n.id).toBeGreaterThan(0);
    expect(n.memoryId).not.toBeNull();
    expect(n.customer).toBe('Acme Corp');
    expect(n.note).toBe('renewal call notes');
    expect(n.version).toBe(1);
    expect(n.status).toBe('active');
    expect(n.changeSummary).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, source FROM memories WHERE id = ?`)
        .get(n.memoryId!) as { content: string; source: string };
      expect(memRow.content).toContain('Acme Corp');
      expect(memRow.content).toContain('renewal call notes');
      expect(memRow.source).toBe('customer_note');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op='customer_note_create' AND target_id=?`)
        .all(String(n.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      expect((JSON.parse(rows[0].metadata_json) as { customer: string }).customer).toBe('Acme Corp');
    } finally { closeHippoDb(db); }
  });

  it('memory mirror carries customer:<lc> tag (lowercased); colon in customer is safe', () => {
    const n = memTags(home, saveCustomerNote(home, 'default', { customer: 'Acme Corp', note: 'x' }).memoryId!);
    expect(n).toContain('customer_note');
    expect(n).toContain('customer:acme corp'); // lowercased
    // a customer containing a colon does not corrupt the tag (it is one element)
    const n2 = saveCustomerNote(home, 'default', { customer: 'acme:corp', note: 'y', extraTags: ['vip'] });
    const tags2 = memTags(home, n2.memoryId!);
    expect(tags2).toContain('customer:acme:corp');
    expect(tags2).toContain('vip');
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both', () => {
    const m0 = countRows(home, 'memories'); const c0 = countRows(home, 'customer_notes');
    const mem = createMemory('throwing note', {
      tags: ['customer_note'], layer: Layer.Semantic, confidence: 'verified', source: 'customer_note', tenantId: 'default',
    });
    expect(() => writeEntry(home, mem, { afterWrite: () => { throw new Error('forced'); } })).toThrow('forced');
    expect(countRows(home, 'memories')).toBe(m0);
    expect(countRows(home, 'customer_notes')).toBe(c0);
  });

  it('supersede chain + version + change_summary + customer_note_supersede audit', () => {
    const v1 = saveCustomerNote(home, 'default', { customer: 'c', note: 'old' });
    const v2 = saveCustomerNote(home, 'default', { customer: 'c', note: 'new', changeSummary: 'fixed typo', supersedesNoteId: v1.id });
    const v3 = saveCustomerNote(home, 'default', { customer: 'c', note: 'newer', supersedesNoteId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v2.changeSummary).toBe('fixed typo');
    const reV1 = loadCustomerNoteById(home, 'default', v1.id)!;
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT 1 FROM audit_log WHERE op='customer_note_supersede' AND target_id=?`).all(String(v1.id)).length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight', () => {
    const v1 = saveCustomerNote(home, 'default', { customer: 'o', note: 'a' });
    saveCustomerNote(home, 'default', { customer: 'o', note: 'b', supersedesNoteId: v1.id });
    expect(() => saveCustomerNote(home, 'default', { customer: 'o', note: 'c', supersedesNoteId: v1.id })).toThrow(/not active/);
    expect(() => saveCustomerNote(home, 'default', { customer: 'x', note: 'c', supersedesNoteId: 99999 })).toThrow(/not found/);
    const c0 = countRows(home, 'customer_notes');
    expect(() => saveCustomerNote(home, 'default', { customer: 'self', note: 'a', supersedesNoteId: 1 })).toThrow(/not active|not found/);
    expect(countRows(home, 'customer_notes')).toBe(c0);
  });

  it('close + close guard (not-found; cannot-close-superseded; cannot re-close)', () => {
    expect(() => closeCustomerNote(home, 'default', 77777)).toThrow(/not found/);
    const v1 = saveCustomerNote(home, 'default', { customer: 'sup', note: 'a' });
    saveCustomerNote(home, 'default', { customer: 'sup', note: 'b', supersedesNoteId: v1.id });
    expect(() => closeCustomerNote(home, 'default', v1.id)).toThrow(/not active/);
    const c = saveCustomerNote(home, 'default', { customer: 'cl', note: 'a' });
    closeCustomerNote(home, 'default', c.id);
    expect(() => closeCustomerNote(home, 'default', c.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger + supersede tenant-match trigger raise ABORT', () => {
    const mem = createMemory('tenant-a', {
      tags: ['customer_note'], layer: Layer.Semantic, confidence: 'verified', source: 'customer_note', tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO customer_notes(memory_id, tenant_id, customer, note, version, status, created_at)
          VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
    const a = saveCustomerNote(home, 'tenant-a', { customer: 'A', note: 'a' });
    const b = saveCustomerNote(home, 'tenant-b', { customer: 'B', note: 'b' });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE customer_notes SET superseded_by=? WHERE id=?`).run(b.id, a.id))
        .toThrow(/superseded_by must reference a customer_note in the same tenant/);
    } finally { closeHippoDb(db2); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the note; old versions loadable', () => {
    const v1 = saveCustomerNote(home, 'default', { customer: 'd', note: 'a' });
    const v2 = saveCustomerNote(home, 'default', { customer: 'd', note: 'b', supersedesNoteId: v1.id });
    deleteEntry(home, v1.memoryId!, 'default');
    deleteEntry(home, v2.memoryId!, 'default');
    expect(loadCustomerNoteById(home, 'default', v1.id)!.memoryId).toBeNull();
    expect(loadCustomerNoteById(home, 'default', v1.id)!.status).toBe('superseded');
    expect(loadCustomerNoteById(home, 'default', v2.id)!.status).toBe('active');
  });

  it('status + customer filters; MANY active notes per customer; loadActiveNotesForCustomer; invalid status', () => {
    // a single customer accrues MANY notes (the key difference from project_brief)
    const a1 = saveCustomerNote(home, 'default', { customer: 'Acme', note: 'note 1' });
    const a2 = saveCustomerNote(home, 'default', { customer: 'Acme', note: 'note 2' });
    const b1 = saveCustomerNote(home, 'default', { customer: 'Beta', note: 'b note' });
    closeCustomerNote(home, 'default', b1.id);
    const acmeActive = loadActiveNotesForCustomer(home, 'default', 'Acme');
    expect(acmeActive.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(acmeActive.length).toBe(2); // MANY-per-customer
    expect(loadCustomerNotes(home, 'default', { customer: 'Beta' }).length).toBe(1);
    expect(loadCustomerNotes(home, 'default', { customer: 'Beta', status: 'active' }).length).toBe(0); // closed
    expect(loadCustomerNotes(home, 'default', { status: 'closed' }).map((x) => x.id)).toEqual([b1.id]);
    expect(loadCustomerNotes(home, 'default').length).toBe(3);
    // @ts-expect-error runtime validation
    expect(() => loadCustomerNotes(home, 'default', { status: 'retired' })).toThrow(/status must be one of/);
    expect(VALID_NOTE_STATES.has('active')).toBe(true);
  });

  it('validation: missing customer/note; single-line customer; caps', () => {
    expect(() => saveCustomerNote(home, 'default', { customer: '   ', note: 'x' })).toThrow(/customer is required/);
    expect(() => saveCustomerNote(home, 'default', { customer: 'c', note: '  ' })).toThrow(/note is required/);
    expect(() => saveCustomerNote(home, 'default', { customer: 'bad\ncustomer', note: 'x' })).toThrow(/single line/);
    expect(() => saveCustomerNote(home, 'default', { customer: 'big', note: 'y'.repeat(MAX_NOTE_LEN + 1) })).toThrow(/note exceeds/);
    expect(() => saveCustomerNote(home, 'default', { customer: 'c', note: 'ok', changeSummary: 'z'.repeat(4097), supersedesNoteId: 1 })).toThrow(/changeSummary exceeds/);
  });

  it('schema v36 produces customer_notes table + 3 triggers + 3 indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='customer_notes'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_customer_notes_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_customer_notes_tenant_match_insert');
      expect(triggers).toContain('trg_customer_notes_tenant_match_update');
      expect(triggers).toContain('trg_customer_notes_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_customer_notes_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_customer_notes_tenant_status');
      expect(indexes).toContain('idx_customer_notes_memory');
      expect(indexes).toContain('idx_customer_notes_customer');
    } finally { closeHippoDb(db); }
  });
});
