// Number-to-text helpers shared by report and eval output.

/** A 0..1 fraction as a percentage with one decimal, e.g. 0.256 -> "25.6%". */
export function pct(fraction: number): string {
  return (fraction * 100).toFixed(1) + '%';
}

/** Rounds to one decimal place. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "1 note", "3 notes"; pass `many` for an irregular plural such as memory and memories. */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
