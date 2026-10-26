// The built-in store's promotion: the promoted-copy write, bound to this store.
import { writePromotedEntry } from '../entries/entry-writes.js';
import type { Promotion } from '../../../base/ports/store/sharing.js';
import type { Handles } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { bound } from '../runtime/bound.js';

export function sqlitePromotion({ on, files }: Handles): Promotion {
  return bound<Promotion>(on, { writeCopy: (db, ...args) => writePromotedEntry(db, files, ...args) }, openStore);
}
