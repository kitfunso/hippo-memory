// The customer note verbs: one account's note, versioned by supersession.

import * as customerNotesModule from '../objects/customer-notes.js';
import { stringFlag } from './flag-values.js';
import { requiredText, versionedVerbs, type VersionedKind } from './versioned-verbs.js';

type CustomerNote = customerNotesModule.CustomerNote;

function printNoteRow(n: CustomerNote): void {
  console.log(`#${n.id} [${n.status}] v${n.version} customer="${n.customer}" memory=${n.memoryId ?? '-'}`);
  if (n.changeSummary) console.log(`    change: ${n.changeSummary}`);
}

const noteKind = (hippoRoot: string, tenantId: string): VersionedKind<CustomerNote, customerNotesModule.NoteStatus, string> => ({
  names: { cmd: 'note', noun: 'Customer note', idLabel: 'note' },
  plural: 'customer notes',
  states: customerNotesModule.VALID_NOTE_STATES,
  usage: [
    'Usage: hippo note new "<customer>" --text "<note>"',
    '       hippo note list [--status active|superseded|closed|all] [--customer "<id>"] [--limit N]',
    '       hippo note get <id>',
    '       hippo note supersede <id> --text "<note>" [--change "<summary>"]',
    '       hippo note close <id>',
  ],
  supersedeUsage: 'Usage: hippo note supersede <id> --text "<note>" [--change "<summary>"]',
  bodyRequired: '--text "<note>"',
  body: (flags) => requiredText(flags, 'text'),
  keyOf: (n) => n.customer,
  save: (customer, note, extraTags, from) => customerNotesModule.saveCustomerNote(hippoRoot, tenantId, {
    customer, note, extraTags, changeSummary: from?.changeSummary, supersedesNoteId: from?.id,
  }),
  recorded: (n) => `Customer note recorded: #${n.id} (v${n.version}) for customer "${n.customer}"`,
  list: (opts, flags) => customerNotesModule.loadCustomerNotes(hippoRoot, tenantId, { ...opts, customer: stringFlag(flags, 'customer')?.trim() || undefined }),
  loadById: (id) => customerNotesModule.loadCustomerNoteById(hippoRoot, tenantId, id),
  close: (id) => customerNotesModule.closeCustomerNote(hippoRoot, tenantId, id),
  printRow: printNoteRow,
  printDetail: (n) => {
    console.log(`  customer: ${n.customer}`);
    console.log(`  status: ${n.status}`);
    console.log(`  version: ${n.version}`);
    console.log(`  note: ${n.note}`);
  },
});

export const handleCustomerNote = versionedVerbs(noteKind);
