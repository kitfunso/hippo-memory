// One in-process turn at a time per key, so independent owners never wait on each other.

/** Runs jobs one after another per key; a key with nothing waiting is forgotten. */
export class SerialQueues<K> {
  private readonly tails = new Map<K, Promise<void>>();

  async run<T>(key: K, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, tail);
    await previous;
    try {
      return await job();
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
      release();
    }
  }
}
