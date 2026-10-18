// The project names of a store, read and rewritten on one handle; hippo.db's own, since a rewrite backs the store up
// and fixes its mirror files.
import type { MemoryEntry } from '../../core/memory.js';
import type { DormantReason } from './consolidation.js';
import type { AppendAuditOpts, AuditEvent } from './types.js';
import type { DormantSnapshot } from './agent-import.js';

export interface ProjectTags {
  /** Runs `fn` on the tenant's project-tag rows and writes, on a handle opened for this call and closed after. */
  on<T>(scope: ProjectTagScope, fn: (store: ProjectTagStore) => T): T;
}

export type SetAsideWhy = 'note-gone' | 'note-changed' | 'handover' | 'project-merge' | 'project-repair';

export type SetAsideResult =
  | { readonly kind: 'untagged'; readonly entry: MemoryEntry }
  | { readonly kind: 'dormant'; readonly id: string };

export type ProjectTagOp = 'project_merge' | 'project_repair';

/** Which of a tenant's rows tagged one project name to read. */
export interface OriginRows {
  readonly origin: string;
  /** Only rows nothing superseded. */
  readonly live?: boolean;
  /** Only rows whose source starts with this. */
  readonly sourcePrefix?: string;
}

/** One project name's live rows: how many, how many whose source starts with the asked prefix, and the newest. */
export interface OriginTally {
  /** '' is user-global, null is unknown. */
  readonly origin: string | null;
  readonly live: number;
  readonly prefixed: number;
  readonly newest: string;
}

export interface ProjectTagReads {
  /** Every project name with live rows, in the order its first row was written. */
  originTallies(sourcePrefix: string): OriginTally[];
  /** The rows `rows` names, oldest first. */
  entriesFromOrigin(rows: OriginRows): MemoryEntry[];
  liveEntriesBySourcePrefix(prefix: string): MemoryEntry[];
  entriesByIds(ids: readonly string[]): Map<string, MemoryEntry>;
  /** The readable dormant snapshots whose row carried project name `origin`. */
  dormantFromOrigin(origin: string): DormantSnapshot[];
  dormantByIds(ids: readonly string[]): Map<string, DormantSnapshot>;
  auditEvents(op: ProjectTagOp): AuditEvent[];
  compactionTranscripts(): Array<{ transcript: string; cwd: string | null }>;
  compactionOriginsWithCwd(): Array<{ origin: string; cwd: string }>;
  holdsOrigin(table: 'memories' | 'compactions', name: string): boolean;
}

export interface ProjectTagWrites extends ProjectTagReads {
  setAside(tag: string, row: MemoryEntry, why: SetAsideWhy): SetAsideResult;
  restampOrigin(from: string, into: string): void;
  restampCompactions(from: string, into: string): number;
  replaceDormant(id: string, entry: MemoryEntry): void;
  stampOrigins(rows: ReadonlyArray<{ readonly id: string; readonly origin: string }>): void;
  /** A live row to dormant storage, restorable, as sleep's dormant move does. */
  retire(row: MemoryEntry, reason: DormantReason, now: Date): void;
  audit(op: ProjectTagOp, metadata: AppendAuditOpts['metadata']): void;
}

/** A rewrite's answer plus the ids whose mirrors are rewritten, and those whose mirrors go, once it commits. */
export interface TagRewrite<T> {
  readonly result: T;
  readonly rewrite: readonly string[];
  readonly purge: readonly string[];
}

export interface ProjectTagStore extends ProjectTagReads {
  readonly hippoRoot: string;
  /** One transaction; a dry run rolls back with no backup, else the store is backed up first and mirrors follow the
   * commit. */
  rewrite<T>(
    opts: { readonly dryRun: boolean; readonly backupLabel: string },
    body: (tx: ProjectTagWrites, backup: string | null) => TagRewrite<T>,
  ): T;
  repairedOnce(): boolean;
  markRepairedOnce(): void;
}

export interface ProjectTagScope {
  readonly tenantId: string;
  /** Who the audit rows name. */
  readonly actor: string;
}
