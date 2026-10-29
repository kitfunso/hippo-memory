// What one process keeps between its store connections: the open steps each store has run, the
// request sessions still open, idle read handles, and file writes held back. A composition root
// makes one, hands it to the stores it builds, and disposes it from its own exit hook; an open
// given no runtime starts fresh.
import * as path from 'node:path';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import type { DatabaseSyncLike } from './sqlite.js';
import { HeldWrites } from './held-writes.js';
import { DetachedSet } from '../base/util/detached-set.js';

/** The lifetime counter increments a store write adds. */
export interface StatsCounts {
  readonly remembered: number;
  readonly recalled: number;
  readonly forgotten: number;
}

/** A request session the runtime closes when the process exits before the session settles. */
interface OpenSession {
  close(): void;
}

// Per pool key: a server answers several requests at once, and each closing session hands its
// handle back.
const IDLE_PER_KEY = 4;

/** The resolved path of a store's hippo.db, the key every per-store record here uses. */
export function storeKey(hippoRoot: string): string {
  return path.resolve(hippoRoot, 'hippo.db');
}

export class StoreRuntime {
  /** Mirror and stats writes held back to at most one per interval per root. */
  readonly held = new HeldWrites();
  readonly #settled = new Map<string, Set<string>>();
  readonly #open = new Set<OpenSession>();
  readonly #idle = new Map<string, DatabaseSyncLike[]>();
  readonly #background = new Set<string>();
  readonly #stats = new Map<string, StatsCounts>();
  readonly #detached = new DetachedSet();

  /** Whether `step` has run to its end on the store at `key`. */
  hasRun(key: string, step: string): boolean {
    return this.#settled.get(key)?.has(step) ?? false;
  }

  markRun(key: string, step: string): void {
    const steps = this.#settled.get(key) ?? new Set<string>();
    this.#settled.set(key, steps.add(step));
  }

  /** Makes `step`, or every step when none is named, due again on the store at `key`. */
  forget(key: string, step?: string): void {
    if (step === undefined) this.#settled.delete(key);
    else this.#settled.get(key)?.delete(step);
  }

  track(session: OpenSession): void {
    this.#open.add(session);
  }

  untrack(session: OpenSession): void {
    this.#open.delete(session);
  }

  /** Whether a checkpointer of this runtime checkpoints the store at `key` off its connections'
   * commits. */
  checkpointsInBackground(key: string): boolean {
    return this.#background.has(key);
  }

  markBackground(key: string, on: boolean): void {
    if (on) this.#background.add(key);
    else this.#background.delete(key);
    // An idle handle keeps the checkpoint limit it opened with, so the store's idle handles close
    // for fresh ones.
    for (const [poolKey, idle] of this.#idle) {
      if (!poolKey.startsWith(`${key}\0`)) continue;
      for (const db of idle) closeQuietly(db);
      this.#idle.delete(poolKey);
    }
  }

  /** Takes the stats increments a busy store refused, to fold into the next update. */
  takeStats(root: string): StatsCounts | undefined {
    const held = this.#stats.get(root);
    this.#stats.delete(root);
    return held;
  }

  holdStats(root: string, counts: StatsCounts): void {
    this.#stats.set(root, counts);
  }

  /** An open idle handle for `poolKey`, or undefined. */
  takeIdle(poolKey: string): DatabaseSyncLike | undefined {
    const idle = this.#idle.get(poolKey);
    for (let db = idle?.pop(); db !== undefined; db = idle?.pop()) {
      if (db.isOpen !== false) return db;
    }
    return undefined;
  }

  /** Keeps `db` for the next session on `poolKey`; false when the pool is full and the caller
   * closes it. */
  giveIdle(poolKey: string, db: DatabaseSyncLike): boolean {
    const idle = this.#idle.get(poolKey) ?? [];
    if (idle.length >= IDLE_PER_KEY) return false;
    idle.push(db);
    this.#idle.set(poolKey, idle);
    return true;
  }

  /** Closes every idle handle, so a held connection can be the store's last. */
  closeIdle(): void {
    for (const idle of this.#idle.values()) for (const db of idle) closeQuietly(db);
    this.#idle.clear();
  }

  /** Keeps work nothing waits on, such as a command's embed, until dispose settles it. */
  detach(work: Promise<unknown>): void {
    this.#detached.detach(work);
  }

  /** Waits for the detached work, up to `withinMs` when given, for a root that closes its stores
   * itself; resolves with how many were still running. */
  settle(withinMs?: number): Promise<number> {
    return this.#detached.settle(withinMs);
  }

  /** Settles the detached work, which may still write through the stores, then runs closeNow. */
  async dispose(): Promise<void> {
    await this.settle();
    this.closeNow();
  }

  /** Runs the held writes, then closes the open sessions and the idle handles, each step even if
   * the one before throws; it skips detached work, so only a root that cannot wait calls it. */
  closeNow(): void {
    try {
      this.held.flush();
    } finally {
      for (const session of this.#open) closeSessionQuietly(session);
      this.#open.clear();
      this.closeIdle();
      this.#settled.clear();
      this.#background.clear();
      this.#stats.clear();
    }
  }
}

function closeQuietly(db: DatabaseSyncLike): void {
  try {
    if (db.isOpen !== false) db.close();
  } catch (err) {
    log.error(
      `store runtime: an idle handle did not close: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

function closeSessionQuietly(session: OpenSession): void {
  try {
    session.close();
  } catch (err) {
    log.error(
      `store runtime: a request session did not close: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}
