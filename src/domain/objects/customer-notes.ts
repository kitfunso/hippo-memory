/** customer_note object: many discrete notes per free-form `customer` column (no entities FK yet), each with its own
 *  supersede chain. The `customer_notes` table is the source of truth; the memory mirror (memory_id NULLABLE, ON DELETE
 *  SET NULL) is for recall. */

import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import type { Objects } from '../../base/ports/store.js';
import type { SavableDescriptor } from './descriptor.js';
import { capText, requireLine, requireText } from './fields.js';
import { listObjects } from './lifecycle.js';
import type { CustomerNote, NoteStatus } from '../../base/records/object-types.js';

export type { CustomerNote, NoteStatus } from '../../base/records/object-types.js';

export const VALID_NOTE_STATES: ReadonlySet<NoteStatus> = new Set<NoteStatus>(['active', 'superseded', 'closed']);

/** Field caps (untrusted at the HTTP/SDK boundary). note is a body, so a larger cap than the 4096 short-field
 *  convention. */
export const MAX_CUSTOMER_LEN = 256;
export const MAX_NOTE_LEN = 8192;

export interface SaveCustomerNoteOptions {
  customer: string;
  note: string;
  /** The delta note for a supersession; ignored (stored NULL) on a fresh create. */
  changeSummary?: string;
  /** Table id of an ACTIVE note this new version supersedes. */
  supersedesNoteId?: number;
  /** Extra memory tags merged after ['customer_note', 'customer:<lc>']. */
  extraTags?: string[];
}

export interface ListCustomerNotesOptions {
  status?: NoteStatus;
  /** Filter to a single customer. */
  customer?: string;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

/** Recall-surface content for the memory mirror: customer + note. Named (mirrors buildBriefContent) so the recall
 *  surface is deterministic + unit-testable. */
function buildNoteContent(customer: string, note: string): string {
  return `${customer}\n\n${note}`;
}

export const CUSTOMER_NOTE: SavableDescriptor<'customer_note', SaveCustomerNoteOptions> = {
  kind: 'customer_note',
  label: 'note',
  plural: 'notes',
  states: VALID_NOTE_STATES,
  closableFrom: ['active'],
  draft(opts, now) {
    // The customer becomes a `customer:<lc>` recall tag and an identifier, so it must be one line.
    const customer = requireLine(opts.customer, MAX_CUSTOMER_LEN, 'customer');
    const note = requireText(opts.note, MAX_NOTE_LEN, 'note');
    capText(opts.changeSummary, MAX_SHORT_FIELD_LEN, 'changeSummary');
    return {
      fields: { customer, note },
      content: buildNoteContent(customer, note),
      tags: [`customer:${customer.toLowerCase()}`, ...(opts.extraTags ?? [])],
      supersedesId: opts.supersedesNoteId,
      changeSummary: opts.changeSummary,
      at: now.toISOString(),
    };
  },
};

export function loadCustomerNotes(
  objects: Objects,
  tenantId: string,
  opts: ListCustomerNotesOptions = {},
): Promise<CustomerNote[]> {
  return listObjects(objects, CUSTOMER_NOTE, tenantId, {
    status: opts.status,
    filter: opts.customer,
    limit: opts.limit,
    after: opts.after,
  });
}
