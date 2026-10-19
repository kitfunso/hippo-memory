// The published entry for the store port: the interface every store implements; the roots import the adapter by name.
export type {
  AmbientCandidateRequest,
  ContextReads,
  EntryRemoval,
  EntryTarget,
  EntryWrite,
  EntryWrites,
  HippoStore,
  KeyAudit,
  KeyListQuery,
  KeyMint,
  KeyRevoke,
  KeyGrants,
  KeyWrites,
  LastRecall,
  LastRecallWrites,
  OutcomeWrite,
  RawArchive,
  RecallSearchArgs,
  RecallWrites,
  SelfKeyMint,
  StoreGroup,
  StoreGroups,
  SupersedeWrite,
  VectorBackfillQuery,
  VectorReads,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorWrites,
} from './port.js';
export type {
  CardCreate,
  Cards,
  Conflicts,
  Dormant,
  DormantRestoreRequest,
  Goals,
  Reports,
  Sessions,
  WorkingMemoryFilter,
  WorkingMemoryPush,
} from './port-groups.js';
export type { RejectionCheck, Rejections } from './port/rejections.js';
export type { FailureLog } from './port/failure-log.js';
export type { CallerItemsSaved, Compactions } from './port/compactions.js';
export { hasGroup, requireGroup, type OptionalGroup } from './port.js';
