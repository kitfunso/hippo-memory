import type { MemoryFacts } from '../../memory/memory-facts.js';
import type { ConflictRow } from './conflicts.js';

/** A project's scatter lists each row up to this many rows, and counts grid cells past it. */
export const SCATTER_POINTS_MAX = 4_000;
/** Grid columns span log10(age + 1) up to log10(maxAgeDays + 1); rows span strength 0 to 1. */
export const SCATTER_COLS = 64;
export const SCATTER_ROWS = 32;

/** Each left-out row counts under the first of quarantined, superseded and archived that fits
 * it. */
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
  readonly weakNow: number;
  readonly openConflicts: number;
  readonly lastRetrievedDays: number;
  readonly maxAgeDays: number;
  readonly firstCreatedMs: number | null;
  readonly createdDays: readonly number[];
}

export interface DashboardTotals {
  readonly projects: readonly ProjectTally[];
  readonly excluded: ExcludedCounts;
  readonly openConflicts: number;
}

interface DashboardFilter {
  readonly layers: readonly number[];
  readonly minAgeDays: number;
  readonly maxAgeDays: number;
  readonly minStrength: number;
  readonly maxStrength: number;
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
  readonly origin: Origin;
  readonly sort: DashboardSortKey;
  readonly descending: boolean;
  readonly chip: DashboardChip;
  readonly offset: number;
  readonly limit: number;
}

/** The filtered rows' chip counts, and their strength buckets (strong, fading, weak) now, at 7
 * days and at 30 days. */
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
  readonly head: string;
  readonly truncated: boolean;
  readonly retrievals: number;
  readonly scope: string | null;
  readonly pinned: boolean;
  readonly inConflict: boolean;
  readonly facts: MemoryFacts;
}

interface ScatterPoint {
  readonly id: string;
  readonly ageDays: number;
  readonly strength: number;
  readonly layer: number;
  readonly band: number;
}

/** Every row by created then id while the project holds at most SCATTER_POINTS_MAX, else
 * per-layer cell counts. */
export type ScatterRows =
  | {
      readonly mode: 'points';
      readonly maxAgeDays: number;
      readonly points: readonly ScatterPoint[];
    }
  | { readonly mode: 'grid'; readonly maxAgeDays: number; readonly cells: readonly number[][] };

/** Per project, in the order of DashboardTotals: its live rows and those whose content or tags
 * hold the text. */
export interface SearchTally {
  readonly origin: Origin;
  readonly live: number;
  readonly hits: number;
}

export interface DashboardReads {
  commitCount(): Promise<number | null>;
  totals(tenantId: string, nowMs: number): Promise<DashboardTotals>;
  project(
    tenantId: string,
    origin: Origin,
    nowMs: number,
  ): Promise<{ tally: ProjectTally; scatter: ScatterRows } | null>;
  memoryPage(
    tenantId: string,
    query: DashboardPageQuery,
    nowMs: number,
  ): Promise<{ tally: FilterTally; rows: ListedRow[] } | null>;
  search(tenantId: string, needle: string): Promise<SearchTally[]>;
  openConflictsOf(tenantId: string, memoryId: string): Promise<ConflictRow[]>;
  hasVector(id: string): Promise<boolean>;
  close(): Promise<void>;
}
