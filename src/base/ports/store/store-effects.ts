// The effect of every store method, by group, assembled from the port files; WORKER_OPS derives
// from it.
import { AGENT_IMPORT_EFFECTS } from './agent-import.js';
import { AUDIT_LOG_EFFECTS } from './audit.js';
import { CAPTURES_EFFECTS, COMPACTIONS_EFFECTS, COMPACTION_HOOKS_EFFECTS } from './capture.js';
import { CARDS_EFFECTS } from './cards.js';
import { CONSOLIDATION_EFFECTS } from './consolidation.js';
import { CONTEXT_READS_EFFECTS } from './context-reads.js';
import { DIAGNOSTICS_EFFECTS } from './diagnostics.js';
import { DORMANT_EFFECTS } from './dormant.js';
import { ENTRY_WRITES_EFFECTS } from './entry-writes.js';
import { FOLDER_FILES_EFFECTS } from './folder-files.js';
import { GOALS_EFFECTS } from './goals.js';
import { KEY_WRITES_EFFECTS } from './keys.js';
import { LEARNING_EFFECTS } from './learning.js';
import { LEDGER_EFFECTS } from './ledger.js';
import { OBJECTS_EFFECTS } from './objects.js';
import { PROJECT_TAGS_EFFECTS } from './project-tags.js';
import { FAILURE_LOG_EFFECTS } from './rejections.js';
import { SHARING_EFFECTS } from './sharing.js';
import { EMBEDDING_INDEX_EFFECTS, VECTORS_EFFECTS, VECTOR_WRITES_EFFECTS } from './vectors.js';
import type { MethodEffects } from './effects.js';
import type { BaseMethods, StoreGroups } from '../store.js';

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
  objects: OBJECTS_EFFECTS,
  cards: CARDS_EFFECTS,
  goals: GOALS_EFFECTS,
  dormant: DORMANT_EFFECTS,
  failureLog: FAILURE_LOG_EFFECTS,
  compactions: COMPACTIONS_EFFECTS,
  ledger: LEDGER_EFFECTS,
  embeddingIndex: EMBEDDING_INDEX_EFFECTS,
  folderFiles: FOLDER_FILES_EFFECTS,
  sharing: SHARING_EFFECTS,
  consolidation: CONSOLIDATION_EFFECTS,
  learning: LEARNING_EFFECTS,
  captures: CAPTURES_EFFECTS,
  compactionHooks: COMPACTION_HOOKS_EFFECTS,
  projectTags: PROJECT_TAGS_EFFECTS,
  diagnostics: DIAGNOSTICS_EFFECTS,
  agentImport: AGENT_IMPORT_EFFECTS,
} as const satisfies { readonly [G in keyof StoreGroups]: MethodEffects<StoreGroups[G]> } & {
  readonly base: MethodEffects<BaseMethods>;
};
