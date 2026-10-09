// Seeded property checks with no dependency: a fixed seed replays a run, and a failure names the seed, the run and the smallest failing input found.
import { inspect } from 'node:util';

/** Numbers in [0, 1); one seed always gives one sequence. */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generated value and the simpler values to try in its place once it fails a check. */
export interface Sample<T> {
  readonly value: T;
  readonly smaller: () => Sample<T>[];
}

export type Gen<T> = (rng: Rng) => Sample<T>;

export function just<T>(value: T): Gen<T> {
  return () => ({ value, smaller: () => [] });
}

export function pick<T>(items: readonly T[]): Gen<T> {
  return (rng) => ({ value: items[Math.floor(rng() * items.length)]!, smaller: () => [] });
}

export function oneOf<T>(gens: readonly Gen<T>[]): Gen<T> {
  return (rng) => gens[Math.floor(rng() * gens.length)]!(rng);
}

function intSample(value: number, origin: number): Sample<number> {
  const smaller = (): Sample<number>[] => {
    const steps = new Set([origin, value - Math.trunc((value - origin) / 2), value - Math.sign(value - origin)]);
    steps.delete(value);
    return [...steps].map((step) => intSample(step, origin));
  };
  return { value, smaller };
}

/** A whole number in [min, max]; it shrinks toward 0 when the range holds 0, else toward `min`. */
export function int(min: number, max: number): Gen<number> {
  const origin = min <= 0 && max >= 0 ? 0 : min;
  return (rng) => intSample(min + Math.floor(rng() * (max - min + 1)), origin);
}

export function map<T, U>(gen: Gen<T>, f: (value: T) => U): Gen<U> {
  const lift = (sample: Sample<T>): Sample<U> => ({ value: f(sample.value), smaller: () => sample.smaller().map(lift) });
  return (rng) => lift(gen(rng));
}

function pairSample<A, B>(a: Sample<A>, b: Sample<B>): Sample<[A, B]> {
  return { value: [a.value, b.value], smaller: () => [...a.smaller().map((s) => pairSample(s, b)), ...b.smaller().map((s) => pairSample(a, s))] };
}

/** Two values drawn in order; nest it for three or more. */
export function both<A, B>(a: Gen<A>, b: Gen<B>): Gen<[A, B]> {
  return (rng) => pairSample(a(rng), b(rng));
}

// Single-item drops past this index are skipped, so one shrink round of a long array stays cheap.
const DROP_LIMIT = 24;

function arrSample<T>(items: readonly Sample<T>[], min: number): Sample<T[]> {
  const smaller = (): Sample<T[]>[] => {
    const out: Sample<T[]>[] = [];
    const half = Math.ceil(items.length / 2);
    if (half > 0 && items.length - half >= min) out.push(arrSample(items.slice(half), min), arrSample(items.slice(0, items.length - half), min));
    if (items.length > min) {
      for (let i = 0; i < Math.min(items.length, DROP_LIMIT); i++) out.push(arrSample(items.filter((_, j) => j !== i), min));
    }
    items.forEach((item, i) => {
      for (const simpler of item.smaller()) out.push(arrSample(items.map((kept, j) => (j === i ? simpler : kept)), min));
    });
    return out;
  };
  return { value: items.map((item) => item.value), smaller };
}

/** `min` to `max` items; it shrinks by dropping halves, then single items, then by shrinking an item. */
export function arr<T>(gen: Gen<T>, min: number, max: number): Gen<T[]> {
  return (rng) => {
    const length = min + Math.floor(rng() * (max - min + 1));
    return arrSample(Array.from({ length }, () => gen(rng)), min);
  };
}

/** `min` to `max` characters of `alphabet`, counted in code points. */
export function str(alphabet: string, min: number, max: number): Gen<string> {
  return map(arr(pick([...alphabet]), min, max), (chars) => chars.join(''));
}

// A check that still fails after this many tries is reported as it stands.
const SHRINK_BUDGET = 600;

function failureOf<T>(check: (value: T) => void, value: T): Error | null {
  try {
    check(value);
    return null;
  } catch (thrown) {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  }
}

function shrink<T>(start: Sample<T>, startError: Error, check: (value: T) => void) {
  let sample = start;
  let error = startError;
  let budget = SHRINK_BUDGET;
  for (let moved = true; moved && budget > 0;) {
    moved = false;
    for (const candidate of sample.smaller()) {
      if (budget-- <= 0) break;
      const failed = failureOf(check, candidate.value);
      if (failed === null) continue;
      sample = candidate;
      error = failed;
      moved = true;
      break;
    }
  }
  return { sample, error };
}

/** Printable ASCII only, so an invisible or look-alike character in a failing input can be read and pasted back. */
function show<T>(value: T): string {
  return inspect(value, { depth: 8, breakLength: Infinity, maxArrayLength: 200, maxStringLength: 4000 })
    .replace(/[^\x20-\x7e\n]/gu, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`);
}

/** Runs `check` on `runs` inputs drawn from `gen`; a throw fails the property, naming the seed, the run and the smallest input that still fails. */
export function forAll<T>(seed: number, runs: number, gen: Gen<T>, check: (value: T) => void): void {
  const rng = mulberry32(seed);
  for (let run = 0; run < runs; run++) {
    const drawn = gen(rng);
    const first = failureOf(check, drawn.value);
    if (first === null) continue;
    const { sample, error } = shrink(drawn, first, check);
    throw new Error(`property failed (seed ${seed}, run ${run}); smallest failing input: ${show(sample.value)}\n${error.message}`, { cause: error });
  }
}
