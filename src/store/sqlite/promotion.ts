// The built-in store's promotion: the promoted-copy write, bound to this store.

import { writePromotedEntryAt } from './entry-writes.js';
import type { Promotion } from '../port/promotion.js';
import { type Handles } from './open.js';
import { openStore } from './handles.js';
import { boundWithFiles } from './bound.js';
import { served } from './served.js';

export function sqlitePromotion({ on }: Handles): Promotion {
  return served<Promotion>(boundWithFiles<Promotion>(on, { writeCopy: writePromotedEntryAt }, openStore));
}
