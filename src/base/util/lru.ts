/** Small least-recently-used map; the oldest entry leaves when it is full. */
export class Lru<V> {
  private readonly entries = new Map<string, V>();
  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** The value, left where it is in the recency order. */
  peek(key: string): V | undefined {
    return this.entries.get(key);
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}
