// The project names of a store: the reads `hippo projects`, doctor and the note sync plan from, and the merge and the
// repair, each one transaction, backed up first, whose mirror files follow the commit.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { AuditLog } from './audit.js';
import type { EntryFilter, Reports } from './reports.js';
import type { DormantSnapshot } from './types.js';

export interface ProjectTags {
  /** Every project name with live rows, in the order its first row was written. */
  originTallies(tenantId: string, sourcePrefix: string): Promise<OriginTally[]>;
  /** The readable dormant snapshots whose row `filter` keeps, by tenant then id. Live rows come from entriesWhere. */
  dormantWhere(filter: EntryFilter): Promise<DormantSnapshot[]>;
  /** Each distinct project name, transcript and working folder the tenant's compactions recorded together. */
  compactionOrigins(tenantId: string): Promise<CompactionOrigin[]>;
  /** Folds `from` into `into` and writes the project_merge audit row; a dry run rolls back and writes nothing, backup
   * and mirrors included. */
  merge(scope: ProjectTagScope, request: MergeRequest): Promise<AppliedMerge>;
  /** Applies a repair planned from the reads above and writes the project_repair audit row; a row the plan names that
   * is gone or moved since its read is skipped. */
  repair(scope: ProjectTagScope, plan: RepairPlan): Promise<AppliedRepair>;
  repairedOnce(): Promise<boolean>;
  markRepairedOnce(): Promise<void>;
}

/** What a repair plans from: this group, entry pages and the merge audit rows, which doctor offers on read-only
 * handles. */
export interface ProjectTagReads {
  readonly projectTags: ProjectTags;
  readonly reports: Pick<Reports, 'entriesWhere'>;
  readonly auditLog: Pick<AuditLog, 'listAuditEvents'>;
}

export type SetAsideWhy = 'note-gone' | 'note-changed' | 'handover' | 'project-merge' | 'project-repair';

export type SetAsideResult =
  | { readonly kind: 'untagged'; readonly entry: MemoryEntry }
  | { readonly kind: 'dormant'; readonly id: string };

/** A compaction's project name ('' when none was recorded), Claude transcript and working folder. */
export interface CompactionOrigin {
  readonly origin: string;
  readonly transcript: string | null;
  readonly cwd: string | null;
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
