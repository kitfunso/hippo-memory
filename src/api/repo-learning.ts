// What a surface learns from the folder it runs in: its git history, the code churn that makes a memory stale, and
// the lesson a failed command leaves. Each store a call reaches is named by its caller, so these take no Context.

export { captureError, isGitRepo } from '../domain/learn/autolearn.js';
export { detectChurnStale, type ChurnStaleResult } from '../domain/learn/invalidation.js';
