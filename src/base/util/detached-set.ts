import { errorFields, errorMessage, log } from './log.js';

export class DetachedSet {
  readonly #work = new Set<Promise<void>>();

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
