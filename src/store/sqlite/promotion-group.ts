// The built-in store's promotion: the two existing functions, bound to this hippo root.

import { copyToGlobal } from './global-promote.js';
import type { Promotion } from '../port/promotion.js';
import { memoryReach } from '../tenant-lookup.js';

export function sqlitePromotion(hippoRoot: string): Promotion {
  return {
    reach: (id) => memoryReach(hippoRoot, id),
    copyToGlobal: (id, opts) => copyToGlobal(hippoRoot, id, opts),
  };
}
