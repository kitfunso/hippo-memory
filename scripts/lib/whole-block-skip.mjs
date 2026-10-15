// The whole-block skip rule the hook ran when Z1 was preregistered; the hook now sends per memory, so the replay keeps
// its own copy to go on measuring the rule Z1 names.
/** @param {{hash: string, skipsSince: number} | null | undefined} last @param {string} hash @param {number} refreshTurns */
export function shouldSkipUnchanged(last, hash, refreshTurns) {
  if (!last || last.hash !== hash) return false;
  return !(refreshTurns > 0 && last.skipsSince >= refreshTurns);
}
