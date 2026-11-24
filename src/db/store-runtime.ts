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

interface OpenSession {
  close(): void;
}

const IDLE_PER_KEY = 4;

/** The resolved path of a store's hippo.db, the key every per-store record here uses. */
export function storeKey(hippoRoot: string): string {
  return path.resolve(hippoRoot, 'hippo.db');
}

/** What a root states when it makes its runtime. */
export interface StoreRuntimeOptions {
  readonly readOnly?: boolean;
}

export class StoreRuntime {
  readonly held = new HeldWrites();
  readonly readOnly: boolean;
  readonly #settled = new Map<string, Set<string>>();
  readonly #open = new Set<OpenSession>();
  readonly #idle = new Map<string, DatabaseSyncLike[]>();
  readonly #background = new Set<string>();
  readonly #stats = new Map<string, StatsCounts>();
  readonly #detached = new DetachedSet();

  constructor(opts: StoreRuntimeOptions = {}) {
    this.readOnly = opts.readOnly === true;
  }

  hasRun(key: string, step: string): boolean {
    return this.#settled.get(key)?.has(step) ?? false;
  }

  markRun(key: string, step: string): void {
    const steps = this.#settled.get(key) ?? new Set<string>();
    this.#settled.set(key, steps.add(step));
  }

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

  checkpointsInBackground(key: string): boolean {
    return this.#background.has(key);
  }

  markBackground(key: string, on: boolean): void {
    if (on) this.#background.add(key);
    else this.#background.delete(key);
    for (const [poolKey, idle] of this.#idle) {
      if (!poolKey.startsWith(`${key}\0`)) continue;
      for (const db of idle) closeQuietly(db);
      this.#idle.delete(poolKey);
    }
  }

  takeStats(root: string): StatsCounts | undefined {
    const held = this.#stats.get(root);
    this.#stats.delete(root);
    return held;
  }

  holdStats(root: string, counts: StatsCounts): void {
    this.#stats.set(root, counts);
  }

  takeIdle(poolKey: string): DatabaseSyncLike | undefined {
    const idle = this.#idle.get(poolKey);
    for (let db = idle?.pop(); db !== undefined; db = idle?.pop()) {
      if (db.isOpen !== false) return db;
    }
    return undefined;
  }

  giveIdle(poolKey: string, db: DatabaseSyncLike): boolean {
    const idle = this.#idle.get(poolKey) ?? [];
    if (idle.length >= IDLE_PER_KEY) return false;
    idle.push(db);
    this.#idle.set(poolKey, idle);
    return true;
  }

  closeIdle(): void {
    for (const idle of this.#idle.values()) for (const db of idle) closeQuietly(db);
    this.#idle.clear();
  }

  detach(work: Promise<unknown>): void {
    this.#detached.detach(work);
  }

  settle(withinMs?: number): Promise<number> {
    return this.#detached.settle(withinMs);
  }

  async dispose(): Promise<void> {
    await this.settle();
    this.closeNow();
  }

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
