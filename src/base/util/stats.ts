/** Median of `nums` without reordering the input; 0 for an empty list. */
export function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function clamp(
  value: number,
  { min, max }: { readonly min: number; readonly max: number },
): number {
  return Math.max(min, Math.min(max, value));
}
