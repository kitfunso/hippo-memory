// File writes derived from a store and held back, so each root writes each kind at most once per
// interval; a later write of a kind replaces the held one. A StoreRuntime owns one set and runs
// what is left when it is disposed.
import * as path from 'node:path';
import { errorFields, errorMessage, log } from '../base/util/log.js';

const HELD_INTERVAL_MS = 1000;

/** One root's held writes, the latest of each kind, run together when its timer fires. */
interface RootWrites {
  lastWrite: number;
  readonly writes: Map<string, () => void>;
  timer?: NodeJS.Timeout;
}

// Derived files are rebuilt from the store, so a failed write warns instead of failing a committed
// change.
function runWrite(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    log.warn(
      `${what} not refreshed (${errorMessage(err)}); the database write succeeded`,
      errorFields(err),
    );
  }
}

export class HeldWrites {
  readonly #roots = new Map<string, RootWrites>();

  /** Runs `write` at once when the root has neither written within the interval nor holds a
   * write, else holds it. */
  writeOrHold(root: string, what: string, write: () => void): void {
    const state = this.#stateOf(root);
    // Behind a pending timer it waits its turn, so an older held copy never lands after it.
    if (state.timer === undefined && state.lastWrite + HELD_INTERVAL_MS <= Date.now()) {
      state.lastWrite = Date.now();
      runWrite(what, write);
      return;
    }
    this.#hold(root, state, what, write);
  }

  /** Holds `write` as the root's next `what` write, run within an interval of the root's last
   * write. */
  hold(root: string, what: string, write: () => void): void {
    this.#hold(root, this.#stateOf(root), what, write);
  }

  /** Runs every held write now, of one root or of all. */
  flush(root?: string): void {
    const key = root === undefined ? undefined : path.resolve(root);
    for (const [held, state] of this.#roots) {
      if (key !== undefined && held !== key) continue;
      if (state.timer !== undefined) clearTimeout(state.timer);
      this.#roots.delete(held);
      for (const [what, write] of state.writes) runWrite(what, write);
    }
  }

  #stateOf(root: string): RootWrites {
    const key = path.resolve(root);
    this.#dropIdle();
    const state = this.#roots.get(key) ?? { lastWrite: 0, writes: new Map() };
    this.#roots.set(key, state);
    return state;
  }

  #hold(root: string, state: RootWrites, what: string, write: () => void): void {
    state.writes.set(what, write);
    if (state.timer !== undefined) return;
    const wait = Math.max(0, state.lastWrite + HELD_INTERVAL_MS - Date.now());
    state.timer = setTimeout(() => this.flush(root), wait);
    state.timer.unref();
  }

  // A root idle for a full interval needs no throttle state, so the map holds only recently written
  // roots.
  #dropIdle(): void {
    const now = Date.now();
    for (const [root, state] of this.#roots) {
      if (
        state.timer === undefined &&
        state.writes.size === 0 &&
        now - state.lastWrite >= HELD_INTERVAL_MS
      ) {
        this.#roots.delete(root);
      }
    }
  }
}
