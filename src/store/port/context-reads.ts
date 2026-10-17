import type { MemoryEntry } from '../../core/memory.js';
import type { AmbientLoadResult, AmbientRecallRequest, ContextCandidateFilter, RecentOrigins } from '../candidates.js';
import type { ContinuityKey } from '../sessions.js';
import type { SessionHandoff } from '../../core/handoff.js';
import type { AmbientStoreFilter } from '../ambient.js';
import type { AmbientTallies } from '../../core/ambient.js';
import type { RawRefRow } from '../entry-reads.js';

/** One ambient load: the pins, the `recentNeeded` newest rows `admit` keeps, and the prompt-recall candidates. */
export interface AmbientCandidateRequest {
  readonly recentNeeded: number;
  /** Sees each row in the order `loadAmbientCandidates` reads them, since the delivery ledger counts its refusals. */
  readonly admit: (e: MemoryEntry) => boolean;
  readonly recall?: AmbientRecallRequest;
  readonly origins?: RecentOrigins;
}

/** The reads behind getContext beyond the base `continuity`: its fallback handoff, candidate rows and ambient tallies.
 *  getContext with a query under an embedding provider needs `vectors` too, and answers 501 without it. */
export interface ContextReads {
  /** The newest handoff of the last `maxAgeMs` that is its session's highest id, has no outcome or a partial or failed
   * one, and passes recall's default scope deny, as `loadLatestHandoff` with `unfinishedOnly` and `scopeFilter:
   * 'default-deny'`. Rejects an empty tenant id. */
  unfinishedHandoff(tenantId: string, maxAgeMs: number, key: ContinuityKey | null): Promise<SessionHandoff | null>;
  /** As `loadAmbientCandidates`; `recall` searches with the query `rarestFtsQuery` builds from FTS document counts over
   * every tenant's rows, and finds nothing when no term is indexed. Core keeps only `tenantId`'s rows that its own
   * admit passes, whatever the store returns. */
  ambientCandidates(tenantId: string, request: AmbientCandidateRequest): Promise<AmbientLoadResult>;
  /** As `loadContextCandidates`: at most `filter.cap` live rows, pins and then the least decayed first, returned by
   * created, then id. */
  contextCandidates(tenantId: string, filter: ContextCandidateFilter): Promise<MemoryEntry[]>;
  /** As `loadAmbientTallies`: one aggregate over the live, unarchived
   * rows `filter` admits, less other projects' secret-tagged rows. */
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
