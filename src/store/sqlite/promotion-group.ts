// The built-in store's promotion: the promoted-copy write, bound to this store.

import { writePromotedEntryAt } from '../entry-writes.js';
import type { Promotion } from '../port/promotion.js';
import { type Handles } from '../open.js';
import { openStore } from './handles.js';

export function sqlitePromotion({ on }: Handles): Promotion {
  return {
    writeCopy: async (copy, opts) => on((db, files) => writePromotedEntryAt(db, files, copy, opts), openStore),
  };
}
