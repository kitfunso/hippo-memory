// What the store workers refused, timed out and replaced since the process started; /health reports them beside the audit failure count.

/** Counted on the server thread, across every executor of the process. */
export const workerCounts = {
  /** Calls refused because a thread's queue was full. */
  queueRefusals: 0,
  /** Calls whose request deadline passed, waiting or running. */
  jobsExpired: 0,
  /** Threads stopped at a deadline and replaced. */
  workersReplaced: 0,
};
