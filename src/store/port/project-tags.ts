// The project names of a store: the reads `hippo projects`, doctor and the note sync plan from, and the merge and the
// repair, each one transaction, backed up first, whose mirror files follow the commit.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PageRequest } from './sharing.js';
import type { AuditEvent, DormantSnapshot, EntryPage } from './types.js';

export interface ProjectTags {
  /** Every project name with live rows, in the order its first row was written. */
  originTallies(tenantId: string, sourcePrefix: string): Promise<OriginTally[]>;
  /** A page of the rows `rows` names, oldest first. */
  entriesFromOrigin(tenantId: string, rows: OriginRows, page: PageRequest): Promise<EntryPage>;
  /** A page of the live rows whose source starts with `prefix`, oldest first. */
  liveEntriesBySourcePrefix(tenantId: string, prefix: string, page: PageRequest): Promise<EntryPage>;
  entriesByIds(tenantId: string, ids: readonly string[]): Promise<Map<string, MemoryEntry>>;
  /** The readable dormant snapshots whose row carried project name `origin`. */
  dormantFromOrigin(tenantId: string, origin: string): Promise<DormantSnapshot[]>;
  dormantByIds(tenantId: string, ids: readonly string[]): Promise<Map<string, DormantSnapshot>>;
  auditEvents(tenantId: string, op: ProjectTagOp): Promise<AuditEvent[]>;
  compactionTranscripts(tenantId: string): Promise<Array<{ transcript: string; cwd: string | null }>>;
  compactionOriginsWithCwd(tenantId: string): Promise<Array<{ origin: string; cwd: string }>>;
  holdsOrigin(tenantId: string, table: 'memories' | 'compactions', name: string): Promise<boolean>;
  /** Folds `from` into `into` and writes the project_merge audit row; a dry run rolls back and writes nothing, backup
   * and mirrors included. */
  merge(scope: ProjectTagScope, request: MergeRequest): Promise<AppliedMerge>;
  /** Applies a repair planned from the reads above and writes the project_repair audit row; a row the plan names that
   * is gone or moved since its read is skipped. */
  repair(scope: ProjectTagScope, plan: RepairPlan): Promise<AppliedRepair>;
  repairedOnce(): Promise<boolean>;
  markRepairedOnce(): Promise<void>;
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

export interface ProjectTagScope {
  readonly tenantId: string;
  /** Who the audit rows name. */
  readonly actor: string;
}

export interface ProjectFold {
  readonly from: string;
  readonly into: string;
}

export interface MergeRequest extends ProjectFold {
  readonly dryRun: boolean;
}

/** What folding one project name into another changed. */
export interface FoldResult {
  /** Imports the target already held for the same note, moved to dormant storage; the rest are re-tagged and the next
   * sync files them under the target. */
  readonly setAside: readonly string[];
  readonly restamped: readonly string[];
  readonly dormantRestamped: readonly string[];
  readonly compactions: number;
}

export interface AppliedMerge extends FoldResult {
  readonly backup: string | null;
}

/** A row and the project name the plan read it under; null is unknown. */
export interface RowRead {
  readonly id: string;
  readonly origin: string | null;
}

/** A sleep-merged row and the project its parents put it in. */
export interface RowRetag {
  readonly id: string;
  readonly origin: string;
}

export interface RepairPlan {
  /** Imports filed under the wrong project, set aside. */
  readonly copies: readonly RowRead[];
  /** Applied after the copies, each as `merge` folds. */
  readonly folds: readonly ProjectFold[];
  /** Live user-global sleep merges to re-tag. */
  readonly toProject: readonly RowRetag[];
  /** Live user-global sleep merges whose parents sit in two projects, retired to dormant storage. */
  readonly setAside: readonly string[];
  /** Named in the audit row only. */
  readonly untraced: readonly string[];
}

/** The rows of a plan the repair changed, and its backup. */
export interface AppliedRepair {
  readonly copies: readonly string[];
  readonly toProject: readonly RowRetag[];
  readonly setAside: readonly string[];
  readonly backup: string;
}
