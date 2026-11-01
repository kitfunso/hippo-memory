// The summary DAG reads drill and assemble make on hippo.db's local tier, and the shapes they pass.

import type { MemoryEntry } from '../memory/entry.js';
import type { DescendantAdmission } from '../scope/read-admission.js';

/** One session's live raw rows inside a tenant; `origins` keeps those projects' rows and
 * rows of no project, unset keeps every origin. */
export interface SessionRawQuery {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly origins?: readonly string[];
}

export interface SessionRawCount extends SessionRawQuery {
  /** Counts rows of exactly this scope; unset or empty counts the rows the default deny admits. */
  readonly scope?: string;
  /** The caller's personal scope, which the default deny admits. */
  readonly ownScope?: string;
}

/** What choosing a session's window needs of a raw row, read without its content. */
export interface SessionRawKey {
  readonly id: string;
  readonly created: string;
  readonly strength: number;
  readonly dagParentId: string | null;
  /** Characters of the row's content, as SQLite counts them (never more than its UTF-16 length). */
  readonly contentLength: number;
}

export interface SessionRawKeys extends SessionRawCount {
  /** The newest this many rows; zero or less reads them all. */
  readonly limit: number;
}

export interface SessionRawRows extends SessionRawCount {
  readonly ids: readonly string[];
}

export type { DescendantAdmission };

export interface DescendantPage {
  /** How many rows the caller reads whole, counted from the first row of the first level. */
  readonly rows: number;
}

export interface DescendantWalk {
  /** Levels to read under the summary. */
  readonly depth: number;
  /** `descendantAdmits` asks it of the summary, then of each child read: a refused row is left
   * out of the answer and nothing under it is read. */
  readonly admit: DescendantAdmission;
  /** The least `dag_level` a summary is walked from; below it, as when refused, nothing under it
   * is read. */
  readonly minSummaryLevel?: number;
  /** Set by a caller that shows only the first rows. A store may ignore it; one that honours it
   * returns just those rows and counts every level in `sizes`. */
  readonly page?: DescendantPage;
}

export interface SummaryDescendants {
  readonly summary: MemoryEntry;
  /** The admitted rows of each level, the summary's own children first; a level with none ends
   * the list. */
  readonly levels: MemoryEntry[][];
  /** Set only by a store that honoured `walk.page`: how many rows each level admits, while
   * `levels` holds just the page, in the same order. */
  readonly sizes?: readonly number[];
}

/** The reads behind session assembly and summary drill-down. None writes an audit row. */
export interface DagReads {
  /** How many rows the session holds with no cap, under the scope rule
   * `passesScopeFilterForRecall` applies, so the count never tells of a row the caller could
   * not read. */
  sessionRawCount(query: SessionRawCount): Promise<number>;
  /** The rows `sessionRawCount` counts, newest `limit` of them oldest first (created then id),
   * as keys without content. */
  sessionRawKeys(query: SessionRawKeys): Promise<SessionRawKey[]>;
  /** The rows of `query.ids` that `sessionRawCount` still counts, whole, in no set order; one
   * that left the session, its scope or the live rows since its key was read is not returned. */
  sessionRawRows(query: SessionRawRows): Promise<MemoryEntry[]>;
  /** The tenant's row `id` and up to `walk.depth` levels under it, read in one call so no write
   * of this process lands between levels; null if no such row. Each level lists the children of
   * the one above, parent by parent, children by created then id ascending; a row is listed
   * once, at its first level. */
  summaryWithDescendants(
    tenantId: string,
    id: string,
    walk: DescendantWalk,
  ): Promise<SummaryDescendants | null>;
}
