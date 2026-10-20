/** What a session last sent on a surface, for `lastSentState`. */
export interface LastSent {
  /** `blockHash` of the last injected block. */
  hash: string;
  /** Consecutive `skip` rows since that injection. */
  skipsSince: number;
}

/** Whether a block identical to the session's last injection should be skipped; `refreshTurns` resends it after that
 * many consecutive skips so a long session still sees its pinned rules, 0 never resends. */
export function shouldSkipUnchanged(last: LastSent | null, hash: string, refreshTurns: number): boolean {
  if (!last || last.hash !== hash) return false;
  if (refreshTurns > 0 && last.skipsSince >= refreshTurns) return false;
  return true;
}
