// The agent-memories import's reach into a store chosen by root; synchronous, so each container's writes stay in one
// transaction that never spans an await.
import type { MemoryEntry } from '../../core/memory.js';
import type { AppendAuditOpts } from '../audit.js';
import type { DormantSnapshot } from '../dormant.js';
import type { RenameSourceOptions } from '../entry-writes.js';
import type { GatedWriteResult } from '../gated-write.js';
import type { ProjectTagReads } from '../project-tags.js';
import type { SetAsideResult, SetAsideWhy } from '../set-aside.js';

/** The calls one container's sync makes inside its transaction, bound to the target store's handle and root. */
export interface ContainerTx {
  liveBySourcePrefix(tenantId: string, prefix: string): MemoryEntry[];
  dormantBySourcePrefix(tenantId: string, prefix: string): DormantSnapshot[];
  readDormant(tenantId: string, id: string): DormantSnapshot | null;
  deleteDormant(tenantId: string, id: string): void;
  replaceDormant(tenantId: string, id: string, entry: MemoryEntry): void;
  entryIdTaken(id: string): boolean;
  /** True when `text` matches a rejected-value tombstone of the tenant. */
  isRejected(tenantId: string, text: string): boolean;
  renameSource(tenantId: string, id: string, from: string, to: string): number;
  renameSourceAndOrigin(tenantId: string, id: string, move: RenameSourceOptions): number;
  setTags(entry: MemoryEntry): void;
  supersede(tenantId: string, id: string, newId: string): boolean;
  markSummaryDirty(summaryId: string, tenantId: string, actor: string): void;
  appendAudit(event: AppendAuditOpts): void;
  gatedWrite(entry: MemoryEntry, opts: { actor: string; worthCheck: boolean }): GatedWriteResult;
  setAside(tag: string, row: MemoryEntry, why: SetAsideWhy): SetAsideResult;
  /** The entry with the target store's origin stamped when it has none. */
  stampOrigin(entry: MemoryEntry): MemoryEntry;
}

/** One open target store; close releases its handle, and a stand-in's folder with it. */
export interface ImportTarget {
  readonly root: string;
  /** The tenant the import writes as. */
  readonly tenantId: string;
  liveBySourcePrefix(prefix: string): MemoryEntry[];
  rowsOutsideSourcePrefix(
    prefix: string,
    origins: readonly string[] | null,
  ): Array<{ id: string; content: string; source: string }>;
  projectTagReads(): ProjectTagReads;
  /** `work` in one write scope, or a trial scope that rolls back on `dryRun`. */
  inContainer<T>(scope: string, dryRun: boolean, work: (tx: ContainerTx) => T): T;
  writeMirror(entry: MemoryEntry): void;
  removeMirror(id: string): void;
  bumpRemembered(count: number): void;
  close(): void;
}

export interface AgentImport {
  /** Creates the store at `root` with its folders. */
  create(root: string): void;
  open(root: string, opts: { busyWaitMs?: number }): ImportTarget;
  /** An empty store in a scratch folder a dry run plans against. */
  openStandIn(): ImportTarget;
  /** True when `err` means another writer held the store past its wait. */
  isBusy<E>(err: E): boolean;
}
