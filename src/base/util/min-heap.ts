/** A binary heap that pops the item of least rank first. */
export class MinHeap<T> {
  private items: T[] = [];

  constructor(private readonly rank: (item: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const { items, rank } = this;
    let i = items.push(item) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (rank(items[parent]) <= rank(item)) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = item;
  }

  pop(): T | undefined {
    const { items } = this;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) this.sink(last, 0);
    return top;
  }

  /** Keeps only the items `keep` passes, in heap order again. */
  retain(keep: (item: T) => boolean): void {
    this.items = this.items.filter(keep);
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) this.sink(this.items[i], i);
  }

  private sink(item: T, from: number): void {
    const { items, rank } = this;
    const n = items.length;
    let i = from;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && rank(items[child + 1]) < rank(items[child])) child++;
      if (rank(items[child]) >= rank(item)) break;
      items[i] = items[child];
      i = child;
    }
    items[i] = item;
  }
}
