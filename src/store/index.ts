// The published entry for the store port: the interface plus the built-in SQLite adapter.
export type {
  AmbientCandidateRequest, ContextReads, EntryRemoval, EntryTarget, EntryWrite, EntryWrites, HippoStore, KeyAudit, KeyListQuery,
  KeyMint, KeyRevoke, KeyWrites, LastRecall, LastRecallWrites, OutcomeWrite, RawArchive, RecallSearchArgs, RecallWrites, SelfKeyMint, StoreGroup, StoreGroups,
  SupersedeWrite, VectorBackfillQuery, VectorReads, VectorRowWrite, VectorWrite, VectorWriteResult, VectorWrites,
} from './port.js';
export { hasGroup, requireGroup } from './port.js';
export { sqliteStore } from './sqlite/store.js';
