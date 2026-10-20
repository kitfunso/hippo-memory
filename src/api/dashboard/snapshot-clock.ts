// The dashboard's snapshot ids. The UI refetches every panel when the id rises and drops a reply with a lower one,
// so an id holds while the data and the clock stand still, and rises on a commit, a refresh, the TTL or a restart.
import type { DashboardReads } from '../../store/port/dashboard-reads.js';

/** An outside commit moves the id at most this often. */
const COALESCE_MS = 10_000;
/** Projected strengths track the clock, so the id moves at least this often. */
const TTL_MS = 5 * 60_000;

/** What one dashboard read is dated by: its id, and the instant strengths are judged at. */
export interface Stamp {
  readonly id: number;
  readonly tenantId: string;
  readonly nowMs: number;
}

interface HeldStamp extends Stamp {
  readonly dataVersion: number | null;
  readonly issuedAtMs: number;
}

export interface SnapshotClock {
  /** The held stamp, or a new one when the tenant or commit signal changed, the windows allow it, or `fresh` is set. */
  at(tenantId: string, fresh?: boolean): Promise<Stamp>;
  /** Drops the held stamp after a dashboard write commits, so the next read takes a new id. */
  invalidate(): void;
  /** The last id issued, which is what a client holding the last reply still has. */
  currentId(): number;
}

function stillServes(held: HeldStamp, tenantId: string, dataVersion: number | null, wallMs: number): boolean {
  const age = wallMs - held.issuedAtMs;
  return (
    held.tenantId === tenantId &&
    (held.dataVersion !== null || dataVersion === null) &&
    age < TTL_MS &&
    (held.dataVersion === dataVersion || age < COALESCE_MS)
  );
}

/** Stamps over the store's commit signal; `now` dates the strengths, `cacheClock` ages the stamp. */
export function createSnapshotClock(
  reads: Pick<DashboardReads, 'commitCount'>,
  now: () => number,
  cacheClock: () => number = Date.now,
): SnapshotClock {
  // Wall clock, not `now`, so ids keep rising across restarts and a client holding an old tab never sees a lower one.
  let lastId = Date.now();
  let held: HeldStamp | null = null;
  return {
    async at(tenantId, fresh = false) {
      const nowMs = now();
      // A frozen eval clock (HIPPO_FAKE_NOW) would never age the stamp, so reuse is timed on its own clock.
      const wallMs = cacheClock();
      const dataVersion = await reads.commitCount();
      if (held !== null && !fresh && stillServes(held, tenantId, dataVersion, wallMs)) return held;
      lastId = Math.max(lastId + 1, Date.now());
      held = { id: lastId, tenantId, nowMs, dataVersion, issuedAtMs: wallMs };
      return held;
    },
    invalidate() {
      held = null;
    },
    currentId: () => lastId,
  };
}
