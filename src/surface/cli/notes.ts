// The customer note verbs: one account's note, versioned by supersession.

import type { CustomerNote } from '../../base/records/object-types.js';
import { requiredText, versionedVerbs, type VersionedKind } from './versioned-verbs.js';

function printNoteRow(n: CustomerNote): void {
  console.log(`#${n.id} [${n.status}] v${n.version} customer="${n.customer}" memory=${n.memoryId ?? '-'}`);
  if (n.changeSummary) console.log(`    change: ${n.changeSummary}`);
}

const noteKind: VersionedKind<'customer_note', string> = {
  kind: 'customer_note',
  names: { cmd: 'note', noun: 'Customer note', idLabel: 'note' },
  plural: 'customer notes',
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
  write: (customer, note, from) => ({ customer, note, changeSummary: from?.changeSummary, supersedesNoteId: from?.id }),
  recorded: (n) => `Customer note recorded: #${n.id} (v${n.version}) for customer "${n.customer}"`,
  filterFlag: 'customer',
  printRow: printNoteRow,
  printDetail: (n) => {
    console.log(`  customer: ${n.customer}`);
    console.log(`  status: ${n.status}`);
    console.log(`  version: ${n.version}`);
    console.log(`  note: ${n.note}`);
  },
};

export const handleCustomerNote = versionedVerbs(noteKind);
