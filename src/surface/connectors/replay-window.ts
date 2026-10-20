// In-process only, so a restart forgets every claim; the durable guard behind it is each connector's event log, which
// stores a replayed event as a duplicate and adds no rows.

export interface ReplayWindow {
  /** False when the key was claimed within the window already. */
  claim(key: string, now: number): boolean;
  /** Frees a claim whose delivery failed, so the sender's retry gets through. */
  release(key: string): void;
}

/** A window of signed deliveries already taken; at the cap the oldest claim goes first. */
export function createReplayWindow(ttlMs: number, maxKeys: number): ReplayWindow {
  const seen = new Map<string, number>();
  return {
    claim(key, now) {
      const seenAt = seen.get(key);
      if (seenAt !== undefined && now - seenAt < ttlMs) return false;
      seen.delete(key);
      if (seen.size >= maxKeys) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.set(key, now);
      return true;
    },
    release(key) {
      seen.delete(key);
    },
  };
}
