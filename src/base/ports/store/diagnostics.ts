import type { JsonObject } from '../../util/json.js';
import type { MethodEffects } from './effects.js';

export interface Diagnostics {
  health(cutoffs: HealthCutoffs): Promise<StoreHealth>;
  inventory(): Promise<StoreInventory>;
}

/** What each Diagnostics method does to the store; every adapter honours it. */
export const DIAGNOSTICS_EFFECTS = {
  health: 'read',
  inventory: 'read',
} as const satisfies MethodEffects<Diagnostics>;

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

/** One read's value, or the message of the error that stopped it, so a broken table never hides
 * the reads beside it. */
export type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** ISO times the health reads count from. */
export interface HealthCutoffs {
  readonly since: string;
  readonly stuckBefore: string;
  readonly transcriptFloor: string;
}

export interface StoreHealth {
  readonly schemaVersion: number;
  readonly binarySchemaVersion: number;
  readonly memories: number | null;
  readonly dormant: number | null;
  readonly fts: Attempt<{ memories: number; fts: number } | null>;
  readonly tokens: Attempt<TokenTally>;
  readonly failures: Attempt<number>;
  readonly lastSleep: Attempt<string | undefined>;
  readonly compactions: Attempt<CompactionCounts>;
}

export interface StoreInventory {
  readonly schemaVersion: number;
  readonly minCompatibleBinary: string | null;
  readonly tables: JsonObject;
}

/** What GET /ready asks of a store. */
export interface Readiness {
  ping(): Promise<void>;
}

/** What each Readiness method does to the store; every adapter honours it. */
export const READINESS_EFFECTS = {
  ping: 'read',
} as const satisfies MethodEffects<Readiness>;
