/** Compute scope match between a memory's scope tags and the active scope.
 *  Returns: 1 if matching scope, -1 if mismatching scope, 0 if neutral (no scope on either side). */
export function scopeMatch(memoryTags: string[], activeScope: string | null): -1 | 0 | 1 {
  const scopeTags = memoryTags.filter((t) => t.startsWith('scope:'));
  if (scopeTags.length === 0) return 0;
  if (!activeScope) return 0;
  const scopeKey = `scope:${activeScope}`;
  if (scopeTags.includes(scopeKey)) return 1;
  return -1;
}
