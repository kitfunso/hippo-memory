import type { MemoryEntry } from '../../base/memory/memory.js';
import type { SessionHandoff } from '../../base/session/handoff.js';
import type { AmbientTallies } from '../../base/memory/ambient.js';
import type { AmbientAdmission, AmbientRefusalReason, DescendantAdmission } from '../../base/scope/read-admission.js';
import type { ContinuityKey } from './types.js';

export type { AmbientAdmission, AmbientRefusalReason };

/** One ambient load: the pins, the `recentNeeded` newest rows `ambientRefusal` keeps under `admit`, and the
 * prompt-recall candidates. */
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

/** An ambient load and the rows it refused, in the order `loadAmbientCandidates` read them. */
export interface AmbientCandidates extends AmbientLoadResult {
  refused: AmbientRefusal[];
}

/** The reads behind contextGet beyond the base `continuity`: its fallback handoff, candidate rows and ambient tallies.
 *  contextGet with a query under an embedding provider needs `vectors` too, and answers 501 without it. */
export interface ContextReads {
  /** The newest handoff of the last `maxAgeMs` that is its session's highest id, has no outcome or a partial or failed
   * one, and passes recall's default scope deny, as `loadLatestHandoff` with `unfinishedOnly` and `scopeFilter:
   * 'default-deny'`. Rejects an empty tenant id. */
  unfinishedHandoff(tenantId: string, maxAgeMs: number, key: ContinuityKey | null): Promise<SessionHandoff | null>;
  /** As `loadAmbientCandidates` with `ambientRefusal` as its admit; `recall` searches with the query `rarestFtsQuery`
   * builds from full-text document counts over every tenant's rows, and finds nothing when no term is indexed. Core
   * keeps only `tenantId`'s rows that the admission passes, whatever the store returns. */
  ambientCandidates(tenantId: string, request: AmbientCandidateRequest): Promise<AmbientCandidates>;
  /** As `loadContextCandidates`: at most `filter.cap` live rows, pins and then the least decayed first, returned by
   * created, then id. */
  contextCandidates(tenantId: string, filter: ContextCandidateFilter): Promise<MemoryEntry[]>;
  /** As `loadAmbientTallies`: one aggregate over the live, unarchived rows `filter` admits, less other projects'
   * secret-tagged rows. */
  ambientTallies(tenantId: string, filter: AmbientStoreFilter): Promise<AmbientTallies>;
  /** The tenant's `limit` newest rows, oldest first. */
  newestEntries(tenantId: string, limit: number): Promise<MemoryEntry[]>;
  /** computeSchemaFit of `content` and `tags` against the tenant's newest 2,000 rows. */
  schemaFit(tenantId: string, content: string, tags: readonly string[]): Promise<number>;
  /** Contents of the tenant's live, unextracted rows from `source` tagged `tag`, less one session's, by created, id. */
  liveContentsBySourceAndTag(tenantId: string, source: string, tag: string, exceptSessionId: string): Promise<string[]>;
  /** The tenant's raw rows whose artifact_ref starts with `refPrefix`, by created then id. */
  rawRowsUnderRef(tenantId: string, refPrefix: string): Promise<RawRefRow[]>;
}

export interface AmbientLoadResult {
  entries: MemoryEntry[];
  recall?: MemoryEntry[];
}

export interface AmbientRecallRequest {
  terms: string[];
  limit: number;
  ownScope?: string;
}

/** The rows a non-pinned context read may admit; each predicate is one contextGet's admission applies again in JS. */
export interface ContextCandidateFilter {
  /** Envelope scope asked for by name; absent applies recall's default deny. */
  exactScope?: string;
  /** The caller's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every origin. */
  project?: readonly string[];
  /** Most rows returned; past it, the rows decay has worn least win. */
  cap: number;
  now: Date;
}

/** The origins a caller's recent rows may carry: its project names, and user-global ('') rows when `userGlobal`. */
export interface RecentOrigins {
  readonly names: readonly string[];
  readonly userGlobal: boolean;
}

/** The rows an ambient summary describes: a context read's envelope, origin partition and tag secret veto. */
export interface AmbientStoreFilter {
  exactScope?: string;
  /** The reader's personal scope, which the default deny admits. */
  ownScope?: string;
  /** Rows carrying one of these project names, and user-global rows, pass; absent admits every origin. */
  project?: readonly string[];
  /** The reader's project names: a secret-tagged row counts only inside its own non-empty origin project. */
  currentProject: readonly string[];
  now: Date;
}

export interface RawRefRow {
  id: string;
  artifact_ref: string;
  tags_json: string;
  scope: string | null;
}

/** One session's unsuperseded raw rows inside a tenant; `origins` keeps those projects' rows and rows of no project,
 * unset keeps every origin. */
export interface SessionRawQuery {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly origins?: readonly string[];
}

export interface SessionRawWindow extends SessionRawQuery {
  /** How many of the newest rows to read; zero or less reads them all. */
  readonly cap: number;
}

export interface SessionRawCount extends SessionRawQuery {
  /** Counts rows of exactly this scope; unset or empty counts the rows the default deny admits. */
  readonly scope?: string;
  /** The caller's personal scope, which the default deny admits. */
  readonly ownScope?: string;
}

export type { DescendantAdmission };

/** The two fields `descendantAdmits` judges a row by. */
export type DescendantOrigin = Pick<MemoryEntry, 'scope' | 'originProject'>;

export interface DescendantPage {
  /** How many rows the caller reads whole, counted from the first row of the first level. */
  readonly rows: number;
}

export interface DescendantWalk {
  /** Levels to read under the summary. */
  readonly depth: number;
  /** `descendantAdmits` asks it of the summary, then of each child read: a refused row is left out of the answer and
   * nothing under it is read. */
  readonly admit: DescendantAdmission;
  /** The least `dag_level` a summary is walked from; below it, as when refused, nothing under it is read. */
  readonly minSummaryLevel?: number;
  /** Set by a caller that shows only the first rows. A store may ignore it; one that honours it returns just those rows
   * and counts every level in `sizes`. */
  readonly page?: DescendantPage;
}

export interface SummaryDescendants {
  readonly summary: MemoryEntry;
  /** The admitted rows of each level, the summary's own children first; a level with none ends the list. */
  readonly levels: MemoryEntry[][];
  /** Set only by a store that honoured `walk.page`: how many rows each level admits, while `levels` holds just the
   * page, in the same order. */
  readonly sizes?: readonly number[];
}

/** The reads behind session assembly and summary drill-down. None writes an audit row. */
export interface DagReads {
  /** The newest `cap` rows by created then id, returned oldest first (created, then id, ascending) as
   * `loadSessionRawMemories` does; an empty session id reads nothing. */
  sessionRawEntries(query: SessionRawWindow): Promise<MemoryEntry[]>;
  /** How many rows the session holds with no cap, under the scope rule `passesScopeFilterForRecall` applies, so the
   * count never tells of a row the caller could not read. */
  sessionRawCount(query: SessionRawCount): Promise<number>;
  /** The tenant's row `id` and up to `walk.depth` levels under it, read in one call so no write of this process lands
   * between levels; null if no such row. Each level lists the children of the one above, parent by parent, children by
   * created then id ascending; a row is listed once, at its first level. */
  summaryWithDescendants(tenantId: string, id: string, walk: DescendantWalk): Promise<SummaryDescendants | null>;
}
