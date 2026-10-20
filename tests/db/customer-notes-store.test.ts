/**
 * E2 customer_note first-class object (entity-scoped) - store-layer tests.
 * Docs: docs/plans/2026-06-01-e2-customer-note-object.md
 *
 * Covers what only notes have; the shared lifecycle rules run per kind in typed-object-store.test.ts.
 * 1. saveCustomerNote creates memory + customer_notes row (+ create audit), v1
 * 2. memory mirror carries customer:<lc> tag (lowercased; colon-in-customer safe)
 * 3. status + customer filters; MANY notes per customer
 * 4. validation: missing customer/note; single-line customer; caps
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { saveCustomerNote, closeCustomerNote, loadCustomerNotes } from '../../src/domain/objects/customer-notes.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/base/config/config.js';

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function memTags(home: string, memoryId: string): string[] {
  const db = openHippoDb(home);
  try {
    // SAFETY: caller passes the id of a memory row that was just written, so
    // it exists and its tags_json column is always a JSON array string.
    const r = db.prepare(`SELECT tags_json FROM memories WHERE id = ?`).get(memoryId) as { tags_json: string };
    // SAFETY: tags_json is always written as a JSON array of strings (see
    // src/store/entry-writes.ts writeEntry serialization); never any other JSON shape.
    return JSON.parse(r.tags_json) as string[];
  } finally {
    closeHippoDb(db);
  }
}

describe('customer_notes store (entity-scoped first-class object)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('customer-notes');
  });
  afterEach(() => safeRmSync(home));

  it('saveCustomerNote creates memory + row + customer_note_create audit; v1', async () => {
    const n = await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      customer: 'Acme Corp',
      note: 'renewal call notes',
    });
    // The first row of a fresh AUTOINCREMENT table.
    expect(n.id).toBe(1);
    expect(n.memoryId).not.toBeNull();
    expect(n.customer).toBe('Acme Corp');
    expect(n.note).toBe('renewal call notes');
    expect(n.version).toBe(1);
    expect(n.status).toBe('active');
    expect(n.changeSummary).toBeNull();
    const db = openHippoDb(home);
    try {
      // SAFETY: n.memoryId is the id just returned by saveCustomerNote's memory
      // mirror write, so the row exists with these columns.
      const memRow = db.prepare(`SELECT content, source FROM memories WHERE id = ?`).get(n.memoryId!) as {
        content: string;
        source: string;
      };
      expect(memRow.content).toContain('Acme Corp');
      expect(memRow.content).toContain('renewal call notes');
      expect(memRow.source).toBe('customer_note');
      // SAFETY: metadata_json is always a JSON object with a customer_note_create
      // audit's fields (see src/domain/objects/customer-notes.ts saveCustomerNote audit write).
      const rows = db
        .prepare(`SELECT metadata_json FROM audit_log WHERE op='customer_note_create' AND target_id=?`)
        .all(String(n.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      // SAFETY: metadata_json for a customer_note_create audit row always
      // includes the `customer` field written by saveCustomerNote.
      expect((JSON.parse(rows[0].metadata_json) as { customer: string }).customer).toBe('Acme Corp');
    } finally {
      closeHippoDb(db);
    }
  });

  it('memory mirror carries customer:<lc> tag (lowercased); colon in customer is safe', async () => {
    const n = memTags(
      home,
      (
        await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
          customer: 'Acme Corp',
          note: 'x',
        })
      ).memoryId!,
    );
    expect(n).toContain('customer_note');
    expect(n).toContain('customer:acme corp'); // lowercased
    // a customer containing a colon does not corrupt the tag (it is one element)
    const n2 = await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      customer: 'acme:corp',
      note: 'y',
      extraTags: ['vip'],
    });
    const tags2 = memTags(home, n2.memoryId!);
    expect(tags2).toContain('customer:acme:corp');
    expect(tags2).toContain('vip');
  });

  it('status + customer filters; MANY active notes per customer', async () => {
    // a single customer accrues MANY notes (the key difference from project_brief)
    const a1 = await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      customer: 'Acme',
      note: 'note 1',
    });
    const a2 = await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      customer: 'Acme',
      note: 'note 2',
    });
    const b1 = await saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      customer: 'Beta',
      note: 'b note',
    });
    await closeCustomerNote(objectsAt(home), 'default', b1.id);
    const acmeActive = await loadCustomerNotes(objectsAt(home), 'default', { customer: 'Acme', status: 'active' });
    expect(acmeActive.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(acmeActive.length).toBe(2); // MANY-per-customer
    expect((await loadCustomerNotes(objectsAt(home), 'default', { customer: 'Beta' })).length).toBe(1);
    expect((await loadCustomerNotes(objectsAt(home), 'default', { customer: 'Beta', status: 'active' })).length).toBe(
      0,
    ); // closed
    expect((await loadCustomerNotes(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([
      b1.id,
    ]);
    expect((await loadCustomerNotes(objectsAt(home), 'default')).length).toBe(3);
  });

  it('validation: missing customer/note; single-line customer; caps', async () => {
    await expect(
      saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        customer: '   ',
        note: 'x',
      }),
    ).rejects.toThrow(/customer is required/);
    await expect(
      saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { customer: 'c', note: '  ' }),
    ).rejects.toThrow(/note is required/);
    await expect(
      saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        customer: 'bad\ncustomer',
        note: 'x',
      }),
    ).rejects.toThrow(/single line/);
    await expect(
      saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        customer: 'big',
        note: 'y'.repeat(8192 + 1),
      }),
    ).rejects.toThrow(/note exceeds/);
    await expect(
      saveCustomerNote(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        customer: 'c',
        note: 'ok',
        changeSummary: 'z'.repeat(4097),
        supersedesNoteId: 1,
      }),
    ).rejects.toThrow(/changeSummary exceeds/);
  });
});
