/**
 * E2 customer_note first-class object - the LAST E2 object
 * (docs/plans/2026-06-01-e2-customer-note-object.md).
 *
 * A `customer_note` is a discrete note recorded against an account/customer entity:
 * a `note` body scoped to a `customer`, evolving via the supersede delta lifecycle.
 * Entity-scoping is a free-form `customer` column (the `entities` table is unbuilt -
 * E3.1 planned - so an FK is deferred). Unlike project_brief's one-summary-per-repo,
 * a customer accrues MANY discrete notes over time, each with its own supersede chain
 * (correct a note -> a new version preserving history; close retires it).
 *
 * Reuses the project_brief/skill supersede machinery verbatim (superseded_by self-FK
 * + CAS + INSERT-preflight + server-derived version + change_summary + supersede
 * tenant-match trigger). It has NO assembler/renderer (the simplest E2 object): the
 * contribution is purely the entity-scoping dimension.
 *
 * The `customer_notes` table is the source of truth (survives memory decay); the
 * memory mirror is for recall. memory_id is NULLABLE with ON DELETE SET NULL.
 *
 * Lifecycle: active -> superseded (a corrected version) or active -> closed (retired).
 */

import { openHippoDb, closeHippoDb } from './db.js';
import { writeEntry, assertTenantId } from './store.js';
import { markGraphDirty, removeGraphEntitiesForObject } from './graph.js';
import { createMemory, Layer, CUSTOMER_NOTE_HALF_LIFE_DAYS } from './memory.js';
import { appendAuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type NoteStatus = 'active' | 'superseded' | 'closed';

export const VALID_NOTE_STATES: ReadonlySet<NoteStatus> = new Set<NoteStatus>([
  'active',
  'superseded',
  'closed',
]);

/** Field caps (untrusted at the HTTP/SDK boundary). note is a body, so a larger cap
 *  than the 4096 short-field convention. */
export const MAX_CUSTOMER_LEN = 256;
export const MAX_NOTE_LEN = 8192;
export const MAX_CHANGE_SUMMARY_LEN = 4096;

export interface CustomerNote {
  id: number;
  /** Nullable: ON DELETE SET NULL lets memory deletion proceed without breaking
   *  the note row. */
  memoryId: string | null;
  tenantId: string;
  /** The account/customer entity this note is scoped to (free-form identifier). */
  customer: string;
  /** The note body. */
  note: string;
  /** Server-derived: 1 on a fresh create, predecessor.version + 1 on supersede. */
  version: number;
  status: NoteStatus;
  supersededBy: number | null;
  supersededAt: string | null;
  /** The per-version delta note; set on a successor row only (NULL on a v1). */
  changeSummary: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface SaveCustomerNoteOpts {
  customer: string;
  note: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE note this new version supersedes. */
  supersedesNoteId?: number;
  /** Extra memory tags merged after ['customer_note', 'customer:<lc>']. */
  extraTags?: string[];
}

export interface ListCustomerNotesOpts {
  status?: NoteStatus;
  /** Filter to a single customer. */
  customer?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate + normalise note fields. `customer` is trimmed and MUST be a single line
 * (no newlines): it becomes a `customer:<lc>` recall tag AND an identifier. `note` is
 * kept verbatim (operator content) but capped. Returns the normalised customer.
 */
function validateNoteFields(
  customer: string,
  note: string,
  changeSummary: string | undefined,
): { customer: string } {
  const normalizedCustomer = (customer ?? '').trim();
  if (normalizedCustomer.length === 0) throw new Error('saveCustomerNote: customer is required');
  if (/[\r\n]/.test(normalizedCustomer)) {
    throw new Error('saveCustomerNote: customer must be a single line (no newlines)');
  }
  if (normalizedCustomer.length > MAX_CUSTOMER_LEN) {
    throw new Error(`saveCustomerNote: customer exceeds the ${MAX_CUSTOMER_LEN}-char cap`);
  }
  if (!note || note.trim().length === 0) {
    throw new Error('saveCustomerNote: note is required');
  }
  if (note.length > MAX_NOTE_LEN) {
    throw new Error(`saveCustomerNote: note exceeds the ${MAX_NOTE_LEN}-char cap`);
  }
  if (changeSummary !== undefined && changeSummary.length > MAX_CHANGE_SUMMARY_LEN) {
    throw new Error(`saveCustomerNote: changeSummary exceeds the ${MAX_CHANGE_SUMMARY_LEN}-char cap`);
  }
  return { customer: normalizedCustomer };
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface CustomerNoteRow {
  id: number;
  memory_id: string | null;
  tenant_id: string;
  customer: string;
  note: string;
  version: number;
  status: string;
  superseded_by: number | null;
  superseded_at: string | null;
  change_summary: string | null;
  closed_at: string | null;
  created_at: string;
}

function rowToCustomerNote(row: CustomerNoteRow): CustomerNote {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    customer: row.customer,
    note: row.note,
    version: row.version,
    status: row.status as NoteStatus,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
    changeSummary: row.change_summary,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

const NOTE_COLS = `
  id, memory_id, tenant_id, customer, note, version, status,
  superseded_by, superseded_at, change_summary, closed_at, created_at
`;

/** Recall-surface content for the memory mirror: customer + note. Named (mirrors
 *  buildBriefContent) so the recall surface is deterministic + unit-testable. */
function buildNoteContent(customer: string, note: string): string {
  return `${customer}\n\n${note}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a customer_note (or a new version that supersedes an existing one). Writes
 * the memory mirror + the customer_notes row atomically inside writeEntry's SAVEPOINT.
 * When supersedesNoteId is given, the referenced ACTIVE row is preflighted (status +
 * version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same SAVEPOINT;
 * the new version = predecessor.version + 1 (server-derived).
 *
 * The memory mirror carries a `customer:<lc>` tag (in addition to ['customer_note']
 * + caller extraTags) so scope-aware recall treats the note as entity-local - the
 * project_brief codex-P2 recall-locality lesson applied to entity scoping. There is
 * no self-recursion path (customer_note has no receipt-query/refresh).
 */
export function saveCustomerNote(
  hippoRoot: string,
  tenantId: string,
  opts: SaveCustomerNoteOpts,
  actor: string = 'cli',
): CustomerNote {
  assertTenantId('saveCustomerNote', tenantId);
  const { customer } = validateNoteFields(opts.customer, opts.note, opts.changeSummary);
  const isSupersede = opts.supersedesNoteId !== undefined;
  const changeSummary = isSupersede ? (opts.changeSummary ?? null) : null;

  const now = new Date().toISOString();
  const content = buildNoteContent(customer, opts.note);
  const tags = ['customer_note', `customer:${customer.toLowerCase()}`, ...(opts.extraTags ?? [])];
  const mem = createMemory(content, {
    tags,
    layer: Layer.Semantic,
    confidence: 'verified',
    source: 'customer_note',
    tenantId,
  });
  mem.half_life_days = CUSTOMER_NOTE_HALF_LIFE_DAYS;

  let savedRow: CustomerNoteRow | undefined;

  writeEntry(hippoRoot, mem, {
    actor,
    afterWrite: (db, memoryId) => {
      // Preflight the supersede target BEFORE inserting the new row (so the new
      // autoincrement id can never be its own supersede target); read the
      // predecessor version in the same SELECT for server-derived versioning.
      // Mirrors saveProjectBrief / saveSkill (codex P1 2026-05-28).
      let version = 1;
      if (opts.supersedesNoteId !== undefined) {
        const pred = db.prepare(
          `SELECT status, version FROM customer_notes WHERE id = ? AND tenant_id = ?`,
        ).get(opts.supersedesNoteId, tenantId) as
          | { status: string; version: number }
          | undefined;
        if (!pred) {
          throw new Error(
            `saveCustomerNote: note ${opts.supersedesNoteId} to supersede not found for tenant ${tenantId}`,
          );
        }
        if (pred.status !== 'active') {
          throw new Error(
            `saveCustomerNote: note ${opts.supersedesNoteId} is not active (status='${pred.status}'); only active notes can be superseded.`,
          );
        }
        version = pred.version + 1;
      }

      const result = db.prepare(`
        INSERT INTO customer_notes(
          memory_id, tenant_id, customer, note, version,
          status, superseded_by, superseded_at, change_summary, closed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL, ?)
      `).run(
        memoryId,
        tenantId,
        customer,
        opts.note,
        version,
        changeSummary,
        now,
      );
      const noteId = Number(result.lastInsertRowid ?? 0);

      if (opts.supersedesNoteId !== undefined) {
        const sup = db.prepare(`
          UPDATE customer_notes
          SET status = 'superseded', superseded_by = ?, superseded_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
        `).run(noteId, now, opts.supersedesNoteId, tenantId, noteId);
        if (sup.changes === 0) {
          throw new Error(
            `saveCustomerNote: note ${opts.supersedesNoteId} could not be superseded (no longer active or self-reference).`,
          );
        }
        appendAuditEvent(db, {
          tenantId,
          actor,
          op: 'customer_note_supersede',
          targetId: String(opts.supersedesNoteId),
          metadata: {
            note_id: opts.supersedesNoteId,
            superseded_by: noteId,
            new_version: version,
          },
        });
      }

      const row = db.prepare(`SELECT ${NOTE_COLS} FROM customer_notes WHERE id = ?`)
        .get(noteId) as CustomerNoteRow | undefined;
      if (!row) throw new Error('saveCustomerNote: failed to reload saved note row');
      savedRow = row;

      // GDPR-light metadata: ids + flags only, no note text.
      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'customer_note_create',
        targetId: String(noteId),
        metadata: {
          note_id: noteId,
          customer,
          version,
        },
      });
    },
    afterCommit: () => markGraphDirty(hippoRoot, tenantId, mem.id),
  });

  if (!savedRow) {
    throw new Error('saveCustomerNote: afterWrite did not populate the row');
  }
  return rowToCustomerNote(savedRow);
}

/**
 * Close (retire) an active note. CAS guard WHERE status='active'; 0 changes
 * distinguishes not-found from not-active. A superseded row is terminal.
 */
export function closeCustomerNote(
  hippoRoot: string,
  tenantId: string,
  id: number,
  actor: string = 'cli',
): CustomerNote {
  assertTenantId('closeCustomerNote', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateResult = db.prepare(`
        UPDATE customer_notes
        SET status = 'closed', closed_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'active'
      `).run(now, id, tenantId);

      if (updateResult.changes === 0) {
        const existing = db.prepare(
          `SELECT status FROM customer_notes WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as { status: string } | undefined;
        if (!existing) {
          throw new Error(`closeCustomerNote: note ${id} not found for tenant ${tenantId}`);
        }
        throw new Error(
          `closeCustomerNote: note ${id} is not active (status='${existing.status}'); only active notes can be closed.`,
        );
      }

      const row = db.prepare(`SELECT ${NOTE_COLS} FROM customer_notes WHERE id = ? AND tenant_id = ?`)
        .get(id, tenantId) as CustomerNoteRow | undefined;
      if (!row) throw new Error(`closeCustomerNote: note ${id} not found after UPDATE`);

      appendAuditEvent(db, {
        tenantId,
        actor,
        op: 'customer_note_close',
        targetId: String(id),
        metadata: { note_id: id },
      });

      db.exec('COMMIT');
      const closed = rowToCustomerNote(row);
      // Closing removes the object from the graph. Remove its rows DIRECTLY (deterministic),
      // not only via an enqueued rebuild whose queue item is lost if the mirror is later
      // forgotten (the queue row cascade-deletes with the memory), which would leave the closed
      // object stale and could block that forget (codex P1). Still enqueue when a mirror exists
      // so a concurrent rebuild re-derives consistently (harmless if it also runs).
      removeGraphEntitiesForObject(hippoRoot, tenantId, 'customer', closed.id);
      if (closed.memoryId) {
        markGraphDirty(hippoRoot, tenantId, closed.memoryId);
      }
      return closed;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failures — the throw below is what matters.
      }
      throw e;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function loadCustomerNoteById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): CustomerNote | null {
  assertTenantId('loadCustomerNoteById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare(`SELECT ${NOTE_COLS} FROM customer_notes WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as CustomerNoteRow | undefined;
    return row ? rowToCustomerNote(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

export function loadCustomerNotes(
  hippoRoot: string,
  tenantId: string,
  opts: ListCustomerNotesOpts = {},
): CustomerNote[] {
  assertTenantId('loadCustomerNotes', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.status && !VALID_NOTE_STATES.has(opts.status)) {
    throw new Error(
      `loadCustomerNotes: status must be one of ${Array.from(VALID_NOTE_STATES).join('|')}; got ${opts.status}`,
    );
  }
  const db = openHippoDb(hippoRoot);
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.customer) {
      clauses.push('customer = ?');
      params.push(opts.customer);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT ${NOTE_COLS} FROM customer_notes
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as CustomerNoteRow[];
    return rows.map(rowToCustomerNote);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * All ACTIVE notes for a customer, newest first. Returns a LIST (a customer accrues
 * MANY notes) - this deliberately DIVERGES from project_brief's
 * loadActiveBriefForRepo, which returns a single brief-or-null because a repo has one
 * evolving summary. A future caller cloning the project_brief shape by analogy must
 * not assume a single-return here; the plural name signals the list contract.
 */
export function loadActiveNotesForCustomer(
  hippoRoot: string,
  tenantId: string,
  customer: string,
  opts: { limit?: number } = {},
): CustomerNote[] {
  return loadCustomerNotes(hippoRoot, tenantId, { customer, status: 'active', limit: opts.limit });
}
