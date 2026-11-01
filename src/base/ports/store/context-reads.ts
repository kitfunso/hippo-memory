import type { MemoryEntry } from '../../memory/entry.js';
import type { AmbientTallies } from '../../memory/ambient.js';
import type { AmbientAdmission, AmbientRefusalReason } from '../../scope/read-admission.js';
import type { MethodEffects } from './types.js';

export type { AmbientAdmission, AmbientRefusalReason };

/** One ambient load: the pins, the `recentNeeded` newest rows `ambientRefusal` keeps under
 * `admit`, and the prompt-recall candidates. */
export interface AmbientCandidateRequest {
  readonly recentNeeded: number;
  readonly admit: AmbientAdmission;
  readonly recall?: AmbientRecallRequest;
  readonly origins?: RecentOrigins;
}

/** A row an ambient load read and left out; the delivery ledger counts each one. */
export interface AmbientRefusal {
  readonly id: string;
  readonly reason: AmbientRefusalReason;
}

/** An ambient load and the rows it refused, in the order `listAmbientCandidates` read them. */
export interface AmbientCandidates extends AmbientLoadResult {
  refused: AmbientRefusal[];
}

/** The reads behind contextGet beyond the base `continuity` and `sessions`: its candidate rows and ambient tallies.
 *  contextGet with a query under an embedding provider needs `vectors` too, and answers 501 without it. */
export interface ContextReads {
  /** As `listAmbientCandidates` with `ambientRefusal` as its admit; `recall` searches with the
   * query `rarestFtsQuery` builds from full-text document counts over every tenant's rows, and
   * finds nothing when no term is indexed. Core keeps only `tenantId`'s rows that the admission
   * passes, whatever the store returns. */
  ambientCandidates(tenantId: string, request: AmbientCandidateRequest): Promise<AmbientCandidates>;
  /** As `listContextCandidates`: at most `filter.cap` live rows, pins and then the least decayed
   * first, returned by created, then id. */
  contextCandidates(tenantId: string, filter: ContextCandidateFilter): Promise<MemoryEntry[]>;
  /** As `countAmbient`: one aggregate over the live, unarchived rows `filter` admits, less other
   * projects' secret-tagged rows. */
  ambientTallies(tenantId: string, filter: AmbientStoreFilter): Promise<AmbientTallies>;
  /** computeSchemaFit of `content` and `tags` against the tenant's newest 2,000 rows. */
  schemaFit(tenantId: string, content: string, tags: readonly string[]): Promise<number>;
}

/** What each ContextReads method does to the store; every adapter honours it. */
export const CONTEXT_READS_EFFECTS = {
  ambientCandidates: 'read',
  contextCandidates: 'read',
  ambientTallies: 'read',
  schemaFit: 'read',
} as const satisfies MethodEffects<ContextReads>;

export interface AmbientLoadResult {
  entries: MemoryEntry[];
  recall?: MemoryEntry[];
}

export interface AmbientRecallRequest {
  terms: string[];
  limit: number;
  ownScope?: string;
}

/** The rows a non-pinned context read may admit; each predicate is one contextGet's admission
 * applies again in JS. */
export interface ContextCandidateFilter {
  /** Envelope scope asked for by name; absent applies recall's default deny. */
  exactScope?: string;
  /** The caller's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every
   * origin. */
  project?: readonly string[];
  /** Most rows returned; past it, the rows decay has worn least win. */
  cap: number;
  now: Date;
}

/** The origins a caller's recent rows may carry: its project names, and user-global ('') rows
 * when `userGlobal`. */
export interface RecentOrigins {
  readonly names: readonly string[];
  readonly userGlobal: boolean;
}

/** The rows an ambient summary describes: a context read's envelope, origin partition and tag
 * secret veto. */
export interface AmbientStoreFilter {
  exactScope?: string;
  /** The reader's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every
   * origin. */
  project?: readonly string[];
  /** The reader's project names: a secret-tagged row counts only inside its own non-empty origin
   * project. */
  currentProject: readonly string[];
  now: Date;
}

/** The two fields `descendantAdmits` judges a row by. */
export type DescendantOrigin = Pick<MemoryEntry, 'scope' | 'originProject'>;
