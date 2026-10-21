// The dashboard's reads. Each answers per-project counts, one page, a capped point set or a fixed grid, so what a read
// hands back never grows with the tenant's row count. Strengths are judged at the `nowMs` each read names.
import type { MemoryFacts } from '../../base/memory/memory-facts.js';
import type { ConflictRow } from './conflicts.js';

/** A project's scatter lists each row up to this many rows, and counts grid cells past it. */
export const SCATTER_POINTS_MAX = 4_000;
/** Grid columns span log10(age + 1) up to log10(maxAgeDays + 1); rows span strength 0 to 1. */
export const SCATTER_COLS = 64;
export const SCATTER_ROWS = 32;

/** Each left-out row counts under the first of quarantined, superseded and archived that fits it. */
export interface ExcludedCounts {
  superseded: number;
  archived: number;
  quarantined: number;
}

/** An `origin_project` value: '' is the user-global project and null is a row with no project. */
export type Origin = string | null;

/** Four counts, in band order (pinned, strong, fading, at risk) or in LAYER_ORDER. */
export type Quad = [number, number, number, number];

/** One project's live rows at the read's instant. */
export interface ProjectTally {
  readonly origin: Origin;
  readonly live: number;
  readonly bands: Quad;
  readonly layers: Quad;
  readonly pinned: number;
  readonly embedded: number;
  /** Rows whose strength now is under the at-risk cut. */
  readonly weakNow: number;
  /** Open conflicts with both members live that name a row of the project, each once. */
  readonly openConflicts: number;
  /** The fewest days since one of its rows was retrieved. */
  readonly lastRetrievedDays: number;
  readonly maxAgeDays: number;
  /** The earliest created time that parses, or null when none does. */
  readonly firstCreatedMs: number | null;
  /** Rows per seriesDay of their created time (one that does not parse is today), indices 0 to SERIES_DAYS. */
  readonly createdDays: readonly number[];
}

export interface DashboardTotals {
  /** In the order each project's first live row comes by created, then id. */
  readonly projects: readonly ProjectTally[];
  readonly excluded: ExcludedCounts;
  /** Open conflicts with both members live, each once. */
  readonly openConflicts: number;
}

/** The rows of one project a memory list keeps; an infinite bound keeps every row on that side. */
interface DashboardFilter {
  /** Indices into LAYER_ORDER. */
  readonly layers: readonly number[];
  readonly minAgeDays: number;
  readonly maxAgeDays: number;
  readonly minStrength: number;
  readonly maxStrength: number;
  /** Lower-case text the lower-cased content or tags must hold, or null for no text test. */
  readonly text: string | null;
}

export type DashboardChip = 'all' | 'risk' | 'pinned' | 'conflict';

export type DashboardSortKey =
  | 'content'
  | 'layer'
  | 'strength'
  | 'retrievals'
  | 'last'
  | 'age'
  | 'confidence'
  | 'scope';

export interface DashboardPageQuery extends DashboardFilter {
  /** The project the page lists. */
  readonly origin: Origin;
  /** Ties fall to id, ascending whatever the direction. */
  readonly sort: DashboardSortKey;
  readonly descending: boolean;
  readonly chip: DashboardChip;
  readonly offset: number;
  readonly limit: number;
}

/** The filtered rows' chip counts, and their strength buckets (strong, fading, weak) now, at 7 days and at 30 days. */
export interface FilterTally {
  readonly counts: { all: number; risk: number; pinned: number; conflict: number };
  readonly decay: {
    now: [number, number, number];
    in7d: [number, number, number];
    in30d: [number, number, number];
    pinned: number;
  };
}

/** One live row as a memory list shows it. */
export interface ListedRow {
  readonly id: string;
  /** The content up to LIST_HEAD_CHARS, and whether any was cut. */
  readonly head: string;
  readonly truncated: boolean;
  readonly retrievals: number;
  readonly scope: string | null;
  readonly pinned: boolean;
  /** In an open conflict whose other member is live too. */
  readonly inConflict: boolean;
  readonly facts: MemoryFacts;
}

/** One live row as the scatter plots it; `layer` and `band` are indices. */
interface ScatterPoint {
  readonly id: string;
  readonly ageDays: number;
  readonly strength: number;
  readonly layer: number;
  readonly band: number;
}

/** Every row by created then id while the project holds at most SCATTER_POINTS_MAX, else per-layer cell counts. */
export type ScatterRows =
  | { readonly mode: 'points'; readonly maxAgeDays: number; readonly points: readonly ScatterPoint[] }
  | { readonly mode: 'grid'; readonly maxAgeDays: number; readonly cells: readonly number[][] };

/** Per project, in the order of DashboardTotals: its live rows and those whose content or tags hold the text. */
export interface SearchTally {
  readonly origin: Origin;
  readonly live: number;
  readonly hits: number;
}

export interface DashboardReads {
  /** Moves when another connection commits; null while no hippo.db exists, and no other read then creates one. */
  commitCount(): Promise<number | null>;
  totals(tenantId: string, nowMs: number): Promise<DashboardTotals>;
  /** The project's tally and scatter from one read, or null when it holds no live row. */
  project(
    tenantId: string,
    origin: Origin,
    nowMs: number,
  ): Promise<{ tally: ProjectTally; scatter: ScatterRows } | null>;
  /** The filter's tally and the chip's page of it, sorted, from one read; null when the project holds no live row. */
  memoryPage(
    tenantId: string,
    query: DashboardPageQuery,
    nowMs: number,
  ): Promise<{ tally: FilterTally; rows: ListedRow[] } | null>;
  /** `needle` is lower-case, matched against lower-cased content and tags. */
  search(tenantId: string, needle: string): Promise<SearchTally[]>;
  /** The tenant's open conflicts naming `memoryId`, newest change first, each with both members' columns. */
  openConflictsOf(tenantId: string, memoryId: string): Promise<ConflictRow[]>;
  /** Whether a vector is stored for `id`, whatever its tenant. */
  hasVector(id: string): Promise<boolean>;
  /** Releases the connection commitCount holds; the next call opens it again. */
  close(): Promise<void>;
}
