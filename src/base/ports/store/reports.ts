// The tallies, counters and filtered entry pages the Reports group returns.
import type { JsonValue } from '../../util/json.js';
import type { ConfidenceLevel, Layer, MemoryKind } from '../../memory/entry.js';
import type { TenantId } from '../../util/tenant.js';
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

/** Which memories a filtered read keeps, as data: hippo.db compiles it to a WHERE (sqlite/entry-filter.ts).
 * Each field that is set narrows the rows. */
export interface EntryFilter {
  /** One tenant's rows, or every tenant's under ALL_TENANTS. */
  readonly tenantId: TenantId;
  readonly ids?: readonly string[];
  /** Project names, matched exactly: '' is user-global, and a row with no name matches none. */
  readonly origins?: readonly string[];
  readonly source?: string;
  /** Matched byte for byte, as startsWith does. */
  readonly sourcePrefix?: string;
  /** A row with no artifact ref matches no prefix. */
  readonly artifactRefPrefix?: string;
  /** One tag, carried exactly. */
  readonly tag?: string;
  /** A row with no kind is 'distilled'. */
  readonly kinds?: readonly MemoryKind[];
  /** Only rows nothing superseded. */
  readonly live?: true;
  /** Only rows the session with this id wrote. */
  readonly sessionId?: string;
}

/** The fields past the tenant, each compiled or tested on its own. */
export type EntryNarrowing = Omit<EntryFilter, 'tenantId'>;

/** Where a page starts and how many rows it holds at most; `newest` walks the order backwards, newest row first. */
export interface PageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
  readonly newest?: boolean;
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

/** Read-only reports for `hippo status`, `hippo tokens`, `hippo failures` and the listing verbs. */
export interface Reports {
  tokenUse(tenantId: string, sinceIso: string): Promise<TokenSummary>;
  failures(tenantId: string, sinceIso: string): Promise<FailureSummary>;
  /** Strength tallies and the open-conflict count, read on one snapshot. */
  memoryStatus(
    tenantId: string,
    now: Date,
    atRiskBelow: number,
  ): Promise<StrengthTallies & { openConflicts: number }>;
  /** A page of the rows `filter` keeps, by created then id; ALL_TENANTS pages every tenant (host admin, the api
   * checks). One read for each walk of a filtered set of rows, so no group keeps a read per caller. */
  entriesWhere(filter: EntryFilter, page: PageRequest): Promise<EntryPage>;
  /** Every row in the store, no tenant: host admin. */
  countEntries(): Promise<number>;
  /** The store's lifetime counters and its recent sleep runs: host admin. */
  stats(): Promise<LegacyStats>;
  /** What `hippo status` counts over every row of every tenant, superseded ones too: host admin. */
  statusCounts(now: Date, atRiskBelow: number): Promise<StatusCounts>;
  /** A page of superseded rows with their successors, by the superseded row's created then id: host admin. */
  correctionLinks(page: ReportPage): Promise<CorrectionLinkPage>;
  /** The kind='raw' count and a page of the raw rows missing provenance, by created then id: host admin. */
  rawProvenance(page: ReportPage): Promise<RawProvenancePage>;
  /** Rows the tenant created since the last sleep of the store, looking back at most a day from `now`. */
  createdSinceLastSleep(tenantId: string, now: Date): Promise<number>;
}
