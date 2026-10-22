// The built-in store's promotion: the promoted-copy write, bound to this store.
import { writePromotedEntry } from './entry-writes.js';
import type { Promotion } from '../port/sharing.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { bound } from './bound.js';

export function sqlitePromotion({ on, files }: Handles): Promotion {
  return bound<Promotion>(on, { writeCopy: (db, ...args) => writePromotedEntry(db, files, ...args) }, openStore);
}
