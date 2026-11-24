/** Counted on the server thread, across every executor of the process. */
export const workerCounts = {
  queueRefusals: 0,
  jobsExpired: 0,
  workersReplaced: 0,
};
