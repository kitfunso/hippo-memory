// The built-in store's promotion: the promoted-copy write, bound to this store.
import { writePromotedEntry } from './entry-writes.js';
import type { Promotion } from '../port/sharing.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { boundWithFiles } from './bound.js';
import type { Sync } from './served.js';

export function sqlitePromotion({ on }: Handles): Sync<Promotion> {
  return boundWithFiles<Promotion>(on, { writeCopy: writePromotedEntry }, openStore);
}
