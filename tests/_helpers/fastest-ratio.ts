/** One side of a timing comparison: `setup` runs untimed before each timed `run` and hands it its input. */
export interface TimedRun<S> {
  readonly setup: () => S;
  readonly run: (input: S) => void;
}

function timeOnce<S>({ setup, run }: TimedRun<S>): number {
  const input = setup();
  const started = performance.now();
  run(input);
  return performance.now() - started;
}

/** The fastest of `runs` interleaved timings of `a` over the fastest of `b`, so a GC pause or a busy runner weighs on both alike. */
export function fastestRatio<A, B>(a: TimedRun<A>, b: TimedRun<B>, runs = 5): number {
  let fastestA = Infinity;
  let fastestB = Infinity;
  for (let run = 0; run < runs; run++) {
    fastestA = Math.min(fastestA, timeOnce(a));
    fastestB = Math.min(fastestB, timeOnce(b));
  }
  return fastestA / fastestB;
}
