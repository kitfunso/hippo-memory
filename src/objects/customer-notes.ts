/** customer_note object: many discrete notes per free-form `customer` column (no entities FK yet), each with its own supersede chain.
 *  The `customer_notes` table is the source of truth; the memory mirror (memory_id NULLABLE, ON DELETE SET NULL) is for recall. */

import type { KeysetPosition } from '../util/keyset.js';
import type { SavableDescriptor } from './descriptor.js';
import { checkText, requireLine } from './fields.js';
import { closeObjectAt, listObjectsAt, objectByIdAt, saveObjectAt } from './lifecycle.js';
import type { CustomerNote, NoteStatus } from '../store/object-types.js';

export type { CustomerNote, NoteStatus } from '../store/object-types.js';

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

/** Create a customer_note, or a new version superseding an existing one, in the `objects` store group's one transaction.
 *  The mirror carries a `customer:<lc>` tag so scope-aware recall treats the note as entity-local. */
export function saveCustomerNote(
  hippoRoot: string,
  tenantId: string,
  opts: SaveCustomerNoteOpts,
  actor: string = 'cli',
): CustomerNote {
  return saveObjectAt(CUSTOMER_NOTE, { hippoRoot, tenantId, actor }, opts);
}

/** Close (retire) an active note; CAS on status='active', 0 changes means not-found or not-active. */
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

/** All ACTIVE notes for a customer, newest first. Returns a LIST, unlike project_brief's single-or-null
 *  loadActiveBriefForRepo: a customer accrues many notes. */
export function loadActiveNotesForCustomer(
  hippoRoot: string,
  tenantId: string,
  customer: string,
  opts: { limit?: number } = {},
): CustomerNote[] {
  return loadCustomerNotes(hippoRoot, tenantId, { customer, status: 'active', limit: opts.limit });
}
