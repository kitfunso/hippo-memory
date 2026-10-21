// The tallies and counters the Reports group returns.
import type { JsonValue } from '../../base/util/json.js';
import type { ConfidenceLevel, Layer } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';
import type { FailureSummary } from './rejections.js';
import type { TokenSummary } from './ledger.js';
import type { EntryCursor, EntryPage } from './types.js';

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

/** How many kind='raw' rows the store holds, and each one missing an owner or an artifact ref. */
export interface RawProvenance {
  total: number;
  gaps: Array<{ id: string; owner: string | null; artifactRef: string | null }>;
}

/** Read-only reports for `hippo status`, `hippo tokens`, `hippo failures` and the listing verbs. */
export interface Reports {
  tokenUse(tenantId: string, sinceIso: string): Promise<TokenSummary>;
  failures(tenantId: string, sinceIso: string): Promise<FailureSummary>;
  /** Strength tallies and the open-conflict count, read on one snapshot. */
  memoryStatus(tenantId: string, now: Date, atRiskBelow: number): Promise<StrengthTallies & { openConflicts: number }>;
  /** ALL_TENANTS pages every tenant (host admin; the api checks). */
  entriesPage(tenantId: TenantId, page: { readonly limit: number; readonly after?: EntryCursor }): Promise<EntryPage>;
  /** Every row in the store, no tenant: host admin. */
  countEntries(): Promise<number>;
  /** The store's lifetime counters and its recent sleep runs: host admin. */
  stats(): Promise<LegacyStats>;
  /** What `hippo status` counts over every row of every tenant, superseded ones too: host admin. */
  statusCounts(now: Date, atRiskBelow: number): Promise<StatusCounts>;
  /** Each superseded row with its successor, by the superseded row's created then id: host admin. */
  correctionLinks(): Promise<CorrectionLink[]>;
  /** The kind='raw' count and the raw rows missing provenance, by created then id: host admin. */
  rawProvenance(): Promise<RawProvenance>;
  /** Rows the tenant created since the last sleep of the store, looking back at most a day from `now`. */
  createdSinceLastSleep(tenantId: string, now: Date): Promise<number>;
}
