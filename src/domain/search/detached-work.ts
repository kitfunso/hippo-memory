/** Where a write hands an embed it does not wait on: the root that owns the stores settles it
 * before closing them. */
export interface DetachedWork {
  detach(work: Promise<unknown>): void;
}
