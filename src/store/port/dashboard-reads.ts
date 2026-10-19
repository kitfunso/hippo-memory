// The dashboard snapshot's reads; on LocalFiles because the commit signal they rest on is hippo.db's own.
import type { ConfidenceInputs, MemoryEntry, StrengthInputs } from '../../core/memory.js';
import type { ConflictRow } from './conflicts.js';

/** One live row as the dashboard lists it. `head` is the whole content or at least its first 241 characters. */
export type DashboardRow = StrengthInputs &
  ConfidenceInputs &
  Pick<MemoryEntry, 'id' | 'layer' | 'scope' | 'originProject' | 'kind' | 'supersededBy'> & {
    readonly head: string;
    readonly embedded: boolean;
  };

export type DashboardText = Pick<MemoryEntry, 'id' | 'content' | 'tags'>;

export interface ConflictPair {
  readonly memory_a_id: string;
  readonly memory_b_id: string;
}

/** Each left-out row counts under the first of quarantined, superseded and archived that fits it. */
export interface ExcludedCounts {
  superseded: number;
  archived: number;
  quarantined: number;
}

export interface DashboardScan {
  /** Live rows by created then id. */
  readonly rows: (page: readonly DashboardRow[]) => void;
  /** Open conflicts whose two members are in the tenant. */
  readonly conflicts: (page: readonly ConflictPair[]) => void;
}

export interface DashboardReads {
  /** Moves when another connection commits, read on one held connection; null while no hippo.db exists. */
  commitCount(): number | null;
  /** One tenant in one read transaction, a page at a time; answers the counts of the rows it left out. */
  scan(tenantId: string, visit: DashboardScan): ExcludedCounts;
  /** The live rows' whole text and tags, a page at a time, for a search the heads cannot answer. */
  scanText(tenantId: string, visit: (page: readonly DashboardText[]) => void): void;
  /** The tenant's open conflicts naming `memoryId`, newest change first, each with both members' columns. */
  openConflictsOf(tenantId: string, memoryId: string): readonly ConflictRow[];
  /** Whether a vector is stored for `id`, whatever its tenant. */
  hasVector(id: string): boolean;
  /** Releases the held connection; the next commitCount opens it again. */
  close(): void;
}
