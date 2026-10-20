// What `hippo doctor` and `hippo support-bundle` read from hippo.db's own files: read-only, so a check never creates,
// migrates or locks the store it inspects.
import type { JsonObject } from '../../base/util/json.js';

export interface Diagnostics {
  /** Rejects when the store cannot be opened or its schema version read. */
  health(cutoffs: HealthCutoffs): Promise<StoreHealth>;
  /** Schema version, oldest allowed binary and row count of every table; never reads a memory column. */
  inventory(): Promise<StoreInventory>;
}

export interface CompactionCounts {
  total: number;
  summarised: number;
  started: number;
}

export interface TokenTally {
  injected: number;
  tokensSent: number;
  tokensReread: number;
}

/** One read's value, or the message of the error that stopped it, so a broken table never hides the reads beside it. */
export type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** ISO times the health reads count from. */
export interface HealthCutoffs {
  /** Token and failure rows at or after this count. */
  readonly since: string;
  /** A compaction unfinished since before this is stuck. */
  readonly stuckBefore: string;
  /** A started compaction older than this is past replaying. */
  readonly transcriptFloor: string;
}

export interface StoreHealth {
  readonly schemaVersion: number;
  /** The schema this binary reads and writes; a store above it needs a newer hippo. */
  readonly binarySchemaVersion: number;
  /** Null when the table is missing or unreadable. */
  readonly memories: number | null;
  readonly dormant: number | null;
  /** Null inside a read that worked means the store has no full-text index. */
  readonly fts: Attempt<{ memories: number; fts: number } | null>;
  readonly tokens: Attempt<TokenTally>;
  readonly failures: Attempt<number>;
  /** Undefined inside a read that worked means the store never slept. */
  readonly lastSleep: Attempt<string | undefined>;
  readonly compactions: Attempt<CompactionCounts>;
}

export interface StoreInventory {
  readonly schemaVersion: number;
  /** Oldest hippo binary the store allows, or null when it names none. */
  readonly minCompatibleBinary: string | null;
  /** Row count by table name; null for a table that cannot be counted. */
  readonly tables: JsonObject;
}
