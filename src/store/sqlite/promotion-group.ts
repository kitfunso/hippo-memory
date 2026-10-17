// The built-in store's promotion: the two existing functions, bound to this store.

import { copyToGlobal } from '../global-promote.js';
import type { Promotion } from '../port/promotion.js';
import { memoryReachAt } from '../tenant-lookup.js';
import { type Handles } from '../open.js';

export function sqlitePromotion({ on, files }: Handles): Promotion {
  return {
    reach: (id) => on((db) => memoryReachAt(db, id)),
    copyToGlobal: (id, opts) => copyToGlobal(on, files, id, opts),
  };
}
