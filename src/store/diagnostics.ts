// What `hippo doctor` and `hippo support-bundle` read from a store: one read-only open each, plain data out.
import { closeHippoDb, countTableRows, ftsRowCounts, getMeta, getSchemaVersion, openHippoDbReadOnly } from '../db/index.js';
import { listTableNames } from '../db/tables.js';
import { errorMessage } from '../util/log.js';
import { compactionCountsAt, tokenTallySince, type CompactionCounts, type TokenTally } from './doctor-reads.js';
import { countFailuresSince } from './failure-log.js';
import { lastConsolidationAt } from './index-and-stats.js';
import type { JsonObject } from './working-memory.js';

/** One read's value, or the message of the error that stopped it, so a broken table never hides the reads beside it. */
export type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function attempt<T>(read: () => T): Attempt<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    // The caller turns the message into its own check, so the error stops here.
    return { ok: false, message: errorMessage(err) };
  }
}

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

/** Everything `hippo doctor` reads from one store; throws when it cannot be opened or its schema version read. */
export function readStoreHealth(hippoRoot: string, cutoffs: HealthCutoffs): StoreHealth {
  const db = openHippoDbReadOnly(hippoRoot);
  try {
    return {
      schemaVersion: getSchemaVersion(db),
      memories: countTableRows(db, 'memories'),
      dormant: countTableRows(db, 'dormant_memories'),
      fts: attempt(() => ftsRowCounts(db)),
      tokens: attempt(() => tokenTallySince(db, cutoffs.since)),
      failures: attempt(() => countFailuresSince(db, cutoffs.since)),
      lastSleep: attempt(() => lastConsolidationAt(db)),
      compactions: attempt(() => compactionCountsAt(db, cutoffs.stuckBefore, cutoffs.transcriptFloor)),
    };
  } finally {
    closeHippoDb(db);
  }
}

export interface StoreInventory {
  readonly schemaVersion: number;
  /** Oldest hippo binary the store allows, or null when it names none. */
  readonly minCompatibleBinary: string | null;
  /** Row count by table name; null for a table that cannot be counted. */
  readonly tables: JsonObject;
}

/** Schema version, oldest allowed binary and row count of every table, for a support bundle; never reads a memory column. */
export function readStoreInventory(hippoRoot: string): StoreInventory {
  const db = openHippoDbReadOnly(hippoRoot);
  try {
    const schemaVersion = getSchemaVersion(db);
    const minCompatibleBinary = getMeta(db, 'min_compatible_binary', '') || null;
    const tables: JsonObject = {};
    for (const name of listTableNames(db)) tables[name] = countTableRows(db, name);
    return { schemaVersion, minCompatibleBinary, tables };
  } finally {
    closeHippoDb(db);
  }
}
