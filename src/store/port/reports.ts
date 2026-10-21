// The tallies and counters the Reports group returns.
import type { JsonValue } from '../../base/util/json.js';
import type { ConfidenceLevel, Layer } from '../../base/memory/memory.js';
import type { EntryCursor } from './types.js';

/** Named field set for the legacy `stats.json` mirror: the only fields any caller reads. */
export interface LegacyStats {
  [key: string]: JsonValue;
  total_remembered: JsonValue;
  total_recalled: JsonValue;
  total_forgotten: JsonValue;
  consolidation_runs: JsonValue;
}

/** Whole-tenant health numbers: every row counts, superseded and archived ones too. */
export interface StrengthTallies {
  total: number;
  pinned: number;
  /** Rows tagged exactly `error`. */
  errors: number;
  strengthSum: number;
  /** Unpinned rows whose strength is under `atRiskBelow`. */
  atRisk: number;
}

/** What `hippo status` prints about the whole store: every tenant and superseded rows too. */
export interface StatusCounts {
  total: number;
  byLayer: Record<Layer, number>;
  byConfidence: Record<ConfidenceLevel, number>;
  pinned: number;
  /** Rows whose strength is under the caller's line; unlike StrengthTallies, pinned rows count. */
  atRisk: number;
  agedOut: number;
  avgStrength: number;
  /** Open conflicts of every tenant, the rows listMemoryConflicts returns when given no tenant. */
  openConflicts: number;
  /** Rows that have a stored vector. */
  embedded: number;
}

/** One superseded row and its successor; `sourceCreated` is the `created` of the successor's extraction source, null
 * when it names none that exists. */
export interface CorrectionLink {
  oldId: string;
  newId: string;
  correctedAt: string;
  sourceCreated: string | null;
}

/** What a paged report read asks for: up to `limit` rows after `after`, in the report's created-then-id order. */
export interface ReportPage {
  readonly limit: number;
  readonly after?: EntryCursor;
}

/** One page of correction links and where the next page starts (null after the last). */
export interface CorrectionLinkPage {
  links: CorrectionLink[];
  next: EntryCursor | null;
}

/** One page of provenance gaps; `total` is the raw count on the same snapshot. */
export interface RawProvenancePage extends RawProvenance {
  next: EntryCursor | null;
}

/** How many kind='raw' rows the store holds, and each one missing an owner or an artifact ref. */
export interface RawProvenance {
  total: number;
  gaps: Array<{ id: string; owner: string | null; artifactRef: string | null }>;
}
