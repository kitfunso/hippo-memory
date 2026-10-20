// What a root keeps for the callers it serves. A server, the stdio host and a CLI process each build one and hand it
// down on the Context, so no module holds caller state and no test resets one.
import { RecentRecalls } from './recall/last-recalled.js';
import type { RecallSurface, RingBuffer } from './recall/finish.js';
import type { AutoSleepRunner } from './sleep/auto-sleep.js';

/** How a write starts a background sleep of one folder: the server runs it in its sleep queue's child, stdio in its
 * own process. Consolidation runs on hippo.db, so only a root whose store is hippo.db holds one. */
export interface AutoSleepHost {
  readonly run: AutoSleepRunner;
  /** The tenant that owns the host: consolidation is host-wide, so only its writes start one. */
  readonly hostTenantId: string;
  /** Held while a sleep is counted or run, so two writes landing together start one. */
  readonly latch: { held: boolean };
}

export type AutoSleepStart = Omit<AutoSleepHost, 'latch'>;

/** A host for one folder's auto-sleep, its latch free. */
export function autoSleepHost(start: AutoSleepStart): AutoSleepHost {
  return { ...start, latch: { held: false } };
}

export interface CallerState {
  /** Each surface's session rings, so a repeat on one surface is a first recall on another. */
  readonly rings: Readonly<Record<RecallSurface, Map<string, RingBuffer>>>;
  /** The ids each client was last shown, keyed by resolveClientKey, so its next outcome with no ids lands on them. */
  readonly lastShown: Map<string, string[]>;
  /** Absent where a write starts no sleep: the CLI, or a server started with `autoSleep: false`. */
  readonly autoSleep?: AutoSleepHost;
}

export function createCallerState(autoSleep?: AutoSleepStart): CallerState {
  return {
    rings: { cli: new Map(), mcp: new Map(), http: new Map() },
    lastShown: new RecentRecalls(),
    ...(autoSleep !== undefined && { autoSleep: autoSleepHost(autoSleep) }),
  };
}
