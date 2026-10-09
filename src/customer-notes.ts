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

import type { KeysetPosition } from './keyset.js';
import type { SavableDescriptor } from './objects/descriptor.js';
import { checkText, requireLine } from './objects/fields.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './objects/lifecycle.js';
import type { CustomerNote, NoteStatus } from './store/object-types.js';

export type { CustomerNote, NoteStatus } from './store/object-types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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

/** Recall-surface content for the memory mirror: customer + note. Named (mirrors
 *  buildBriefContent) so the recall surface is deterministic + unit-testable. */
function buildNoteContent(customer: string, note: string): string {
  return `${customer}\n\n${note}`;
}

export const CUSTOMER_NOTE: SavableDescriptor<'customer_note', SaveCustomerNoteOpts> = {
  kind: 'customer_note',
  label: 'note',
  plural: 'notes',
  fn: { get: 'loadCustomerNoteById', close: 'closeCustomerNote', list: 'loadCustomerNotes', save: 'saveCustomerNote' },
  states: VALID_NOTE_STATES,
  closableFrom: ['active'],
  draft(opts) {
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
    return {
      fields: { customer, note: opts.note },
      content: buildNoteContent(customer, opts.note),
      tags: [`customer:${customer.toLowerCase()}`, ...(opts.extraTags ?? [])],
      supersedesId: opts.supersedesNoteId,
      changeSummary: opts.changeSummary,
      at: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a customer_note (or a new version that supersedes an existing one). Writes
 * the memory mirror + the customer_notes row in the `objects` store group's one transaction.
 * When supersedesNoteId is given, the referenced ACTIVE row is preflighted (status +
 * version) BEFORE the INSERT, then CAS-UPDATEd -> superseded in the same transaction;
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
  return saveObjectAt(CUSTOMER_NOTE, { hippoRoot, tenantId, actor }, opts);
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
  return closeObjectAt(hippoRoot, CUSTOMER_NOTE, tenantId, id, actor);
}

export function loadCustomerNoteById(
  hippoRoot: string,
  tenantId: string,
  id: number,
): CustomerNote | null {
  return objectByIdAt(hippoRoot, CUSTOMER_NOTE, tenantId, id);
}

export function loadCustomerNotes(
  hippoRoot: string,
  tenantId: string,
  opts: ListCustomerNotesOpts = {},
): CustomerNote[] {
  return listObjectsAt(hippoRoot, CUSTOMER_NOTE, tenantId, { status: opts.status, filter: opts.customer, limit: opts.limit, after: opts.after });
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
