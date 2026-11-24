import type { MemoryEntry } from '../../memory/entry.js';
import type { AuditLog } from './audit.js';
import type { EntryFilter, PageRequest } from './reports.js';
import type { DormantSnapshot, EntryPage } from './types.js';
import type { MethodEffects } from './effects.js';

export interface ProjectTags {
  originTallies(tenantId: string, sourcePrefix: string): Promise<OriginTally[]>;
  dormantWhere(filter: EntryFilter): Promise<DormantSnapshot[]>;
  compactionOrigins(tenantId: string): Promise<CompactionOrigin[]>;
  merge(scope: ProjectTagScope, request: MergeRequest): Promise<AppliedMerge>;
  repair(scope: ProjectTagScope, plan: RepairPlan): Promise<AppliedRepair>;
  repairedOnce(): Promise<boolean>;
  markRepairedOnce(): Promise<void>;
}

/** What each ProjectTags method does to the store; every adapter honours it. */
export const PROJECT_TAGS_EFFECTS = {
  originTallies: 'read',
  dormantWhere: 'read',
  compactionOrigins: 'read',
  merge: 'write',
  repair: 'write',
  repairedOnce: 'read',
  markRepairedOnce: 'write',
} as const satisfies MethodEffects<ProjectTags>;

/** What a repair plans from: this group, entry pages and the merge audit rows, which doctor
 * offers on read-only handles. */
export interface ProjectTagReads {
  readonly projectTags: ProjectTags;
  entriesWhere(filter: EntryFilter, page: PageRequest): Promise<EntryPage>;
  readonly auditLog: Pick<AuditLog, 'listAuditEvents'>;
}

export type SetAsideWhy =
  | 'note-gone'
  | 'note-changed'
  | 'handover'
  | 'project-merge'
  | 'project-repair';

export type SetAsideResult =
  | { readonly kind: 'untagged'; readonly entry: MemoryEntry }
  | { readonly kind: 'dormant'; readonly id: string };

/** A compaction's project name ('' when none was recorded), Claude transcript and working
 * folder. */
export interface CompactionOrigin {
  readonly origin: string;
  readonly transcript: string | null;
  readonly cwd: string | null;
}

/** One project name's live rows: how many, how many whose source starts with the asked prefix,
 * and the newest. */
export interface OriginTally {
  readonly origin: string | null;
  readonly live: number;
  readonly prefixed: number;
  readonly newest: string;
}

export interface ProjectTagScope {
  readonly tenantId: string;
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
  readonly copies: readonly RowRead[];
  readonly folds: readonly ProjectFold[];
  readonly toProject: readonly RowRetag[];
  readonly setAside: readonly string[];
  readonly untraced: readonly string[];
}

/** The rows of a plan the repair changed, and its backup. */
export interface AppliedRepair {
  readonly copies: readonly string[];
  readonly toProject: readonly RowRetag[];
  readonly setAside: readonly string[];
  readonly backup: string;
}
