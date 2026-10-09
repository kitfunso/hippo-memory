/**
 * customer_note first-class object.
 *
 * A `customer_note` is a discrete note recorded against an account/customer entity:
 * a `note` body scoped to a `customer`, evolving via the supersede delta lifecycle.
 * Entity-scoping is a free-form `customer` column (the `entities` table is unbuilt,
 * so an FK is deferred). Unlike project_brief's one-summary-per-repo,
 * a customer accrues MANY discrete notes over time, each with its own supersede chain
 * (correct a note -> a new version preserving history; close retires it).
 *
 * Reuses the project_brief/skill supersede machinery verbatim (superseded_by self-FK
 * + CAS + INSERT-preflight + server-derived version + change_summary + supersede
 * tenant-match trigger). It has NO assembler/renderer (the simplest first-class object): the
 * contribution is purely the entity-scoping dimension.
 *
 * The `customer_notes` table is the source of truth (survives memory decay); the
 * memory mirror is for recall. memory_id is NULLABLE with ON DELETE SET NULL.
 *
 * Lifecycle: active -> superseded (a corrected version) or active -> closed (retired).
 */

import { onHandle } from './store/open.js';
import { assertTenantId } from './tenant.js';
import type { KeysetPosition } from './keyset.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { checkText, requireLine } from './objects/fields.js';
import { assertObjectStatus, closeObjectOn, dropClosedObjectFromGraph, loadObjectByIdOn, loadObjectsOn, saveObject } from './objects/lifecycle.js';

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
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
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
    // SAFETY: row.status is DB-constrained to NoteStatus values; every INSERT/
    // UPDATE in this file writes only the literal 'active' | 'superseded' | 'closed'.
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

/** What one note write stores, with the customer already trimmed. */
interface NoteFields {
  readonly customer: string;
  readonly note: string;
}

const NOTE: SavableDescriptor<CustomerNote, CustomerNoteRow, 'customer', NoteFields> = {
  table: 'customer_notes',
  cols: NOTE_COLS,
  label: 'note',
  plural: 'notes',
  fn: { get: 'loadCustomerNoteById', close: 'closeCustomerNote', list: 'loadCustomerNotes', save: 'saveCustomerNote' },
  states: VALID_NOTE_STATES,
  closableFrom: ['active'],
  ops: { close: 'customer_note_close', create: 'customer_note_create', supersede: 'customer_note_supersede' },
  idKey: 'note_id',
  graphType: 'customer',
  listFilters: { customer: 'customer' },
  rowTo: rowToCustomerNote,
  source: 'customer_note',
  versioned: true,
  columns: ['customer', 'note'],
  values: (w) => [w.customer, w.note],
  // Ids and the customer name only, never the note text.
  createMeta: (w, version) => ({ customer: w.customer, version }),
};

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
 * + caller extraTags) so scope-aware recall treats the note as entity-local. There is
 * no self-recursion path (customer_note has no receipt-query/refresh).
 */
export function saveCustomerNote(
  hippoRoot: string,
  tenantId: string,
  opts: SaveCustomerNoteOpts,
  actor: string = 'cli',
): CustomerNote {
  assertTenantId(NOTE.fn.save, tenantId);
  // The customer becomes a `customer:<lc>` recall tag and an identifier, so it must be one line.
  const customer = requireLine(opts.customer, MAX_CUSTOMER_LEN, {
    required: 'saveCustomerNote: customer is required',
    singleLine: 'saveCustomerNote: customer must be a single line (no newlines)',
    tooLong: `saveCustomerNote: customer exceeds the ${MAX_CUSTOMER_LEN}-char cap`,
  });
  checkText(opts.note, MAX_NOTE_LEN, {
    required: 'saveCustomerNote: note is required',
    tooLong: `saveCustomerNote: note exceeds the ${MAX_NOTE_LEN}-char cap`,
  });
  checkText(opts.changeSummary, MAX_CHANGE_SUMMARY_LEN, {
    tooLong: `saveCustomerNote: changeSummary exceeds the ${MAX_CHANGE_SUMMARY_LEN}-char cap`,
  });
  return saveObject(hippoRoot, NOTE, tenantId, {
    actor,
    now: new Date().toISOString(),
    fields: { customer, note: opts.note },
    content: buildNoteContent(customer, opts.note),
    tags: [`customer:${customer.toLowerCase()}`, ...(opts.extraTags ?? [])],
    supersedesId: opts.supersedesNoteId,
    changeSummary: opts.changeSummary,
  });
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
  assertTenantId(NOTE.fn.close, tenantId);
  const now = new Date().toISOString();
  return onHandle(hippoRoot, (db) => {
    const closed = closeObjectOn(db, NOTE, tenantId, id, { actor, now });
    dropClosedObjectFromGraph(hippoRoot, NOTE, tenantId, closed);
    return closed;
  });
}

export function loadCustomerNoteById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): CustomerNote | null {
  assertTenantId(NOTE.fn.get, tenantId);
  return onHandle(hippoRoot, (db) => loadObjectByIdOn(db, NOTE, tenantId, id));
}

export function loadCustomerNotes(
  hippoRoot: string,
  tenantId: string,
  opts: ListCustomerNotesOpts = {},
): CustomerNote[] {
  assertTenantId(NOTE.fn.list, tenantId);
  assertObjectStatus(NOTE, opts.status);
  return onHandle(hippoRoot, (db) => loadObjectsOn(db, NOTE, tenantId, opts));
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
