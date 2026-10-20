import type { MemoryEntry } from '../../core/memory.js';
import type { DescendantAdmission } from '../../core/read-admission.js';

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
