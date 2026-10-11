// Number-to-text helpers shared by report and eval output.

/** A 0..1 fraction as a percentage with one decimal, e.g. 0.256 -> "25.6%". */
export function pct(fraction: number): string {
  return (fraction * 100).toFixed(1) + '%';
}
