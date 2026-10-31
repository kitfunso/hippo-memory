// The effect of every store method, by group, assembled from the port files; WORKER_OPS derives
// from it.
import { AUDIT_LOG_EFFECTS } from './audit.js';
import { CONTEXT_READS_EFFECTS } from './context-reads.js';
import { ENTRY_WRITES_EFFECTS } from './entry-writes.js';
import { KEY_WRITES_EFFECTS } from './keys.js';
import { VECTORS_EFFECTS, VECTOR_WRITES_EFFECTS } from './vectors.js';
import type { MethodEffects } from './effects.js';
import type { BaseMethods, CoreGroups } from '../store.js';

/** What each base method does to the store; every adapter honours it. */
export const BASE_EFFECTS = {
  findApiKey: 'read',
  searchRecallEntries: 'read',
  entriesByIds: 'read',
  entriesWhere: 'read',
  activeGoals: 'read',
  freshRawEntries: 'read',
  continuity: 'read',
  planningFallacyEvidence: 'read',
  appendAuditEvents: 'write',
  finishRecall: 'write',
  bumpRecallStats: 'write',
  recordTokens: 'write',
} as const satisfies MethodEffects<BaseMethods>;

/** Every store method's effect, by group, as the port files state them. */
export const STORE_EFFECTS = {
  base: BASE_EFFECTS,
  vectors: VECTORS_EFFECTS,
  keyWrites: KEY_WRITES_EFFECTS,
  vectorWrites: VECTOR_WRITES_EFFECTS,
  entryWrites: ENTRY_WRITES_EFFECTS,
  contextReads: CONTEXT_READS_EFFECTS,
  auditLog: AUDIT_LOG_EFFECTS,
} as const satisfies { readonly [G in keyof CoreGroups]: MethodEffects<CoreGroups[G]> } & {
  readonly base: MethodEffects<BaseMethods>;
};
