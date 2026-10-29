// Work a caller starts and does not wait on, kept by whoever owns the stores it writes to, so that
// owner settles it before closing them.
import { errorFields, errorMessage, log } from './log.js';

export class DetachedSet {
  readonly #work = new Set<Promise<void>>();

  /** Keeps `work` until settle(); a rejection nothing caught is logged here, never dropped. */
  detach(work: Promise<unknown>): void {
    const kept: Promise<void> = work
      .then(
        () => undefined,
        (err) => {
          log.error(`detached work failed: ${errorMessage(err)}`, errorFields(err));
        },
      )
      .finally(() => this.#work.delete(kept));
    this.#work.add(kept);
  }

  /** Waits for every kept promise, work detached meanwhile included, up to `withinMs`; returns how many still run. */
  async settle(withinMs?: number): Promise<number> {
    const drained = this.#drain();
    if (withinMs === undefined) {
      await drained;
      return 0;
    }
    let bound: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      bound = setTimeout(resolve, withinMs);
    });
    await Promise.race([drained, timedOut]);
    clearTimeout(bound);
    return this.#work.size;
  }

  async #drain(): Promise<void> {
    while (this.#work.size > 0) await Promise.all(this.#work);
  }
}
