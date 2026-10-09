/**
 * Statistics and cost accounting for the token-efficiency evals.
 *
 * - Cost: price provider usage over four buckets (uncached input, cache
 *   write, cache read, output). Raw token counts overstate savings when most
 *   input is already cache reads, so every dollar claim goes through here.
 * - Uncertainty: paired bootstrap over tasks, cluster bootstrap (tasks that
 *   share a repository are not independent), and a paired ratio bootstrap for
 *   dollars per resolved task.
 *
 * Deterministic: every resampling function takes a seed, so a published
 * result can be reproduced exactly.
 */

const DEFAULT_ITERATIONS = 5000;
const DEFAULT_TWO_LEVEL_ITERATIONS = 10_000;
const DEFAULT_ALPHA = 0.05;

/** Token usage for one model call or one whole task, split by how it is billed. */
export interface Usage {
  /** Input tokens billed at the base input price (not read from or written to a cache). */
  inputTokens: number;
  /** Input tokens written to a prompt cache. */
  cacheWriteTokens: number;
  /** Input tokens read from a prompt cache. */
  cacheReadTokens: number;
  /** Output tokens, including any reasoning tokens the provider bills as output. */
  outputTokens: number;
}

/**
 * Prices in dollars per million tokens. Take them from the provider's
 * current price page for the exact model; this module has no built-in
 * prices because they change.
 */
export interface Prices {
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
}

/** Sum several usages bucket by bucket. */
export function addUsage(...usages: Usage[]): Usage {
  const total: Usage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const u of usages) {
    total.inputTokens += u.inputTokens;
    total.cacheWriteTokens += u.cacheWriteTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.outputTokens += u.outputTokens;
  }
  return total;
}

/** Dollar cost of `usage` at `prices`. */
export function priceUsage(usage: Usage, prices: Prices): number {
  return (
    usage.inputTokens * prices.inputPerMTok
    + usage.cacheWriteTokens * prices.cacheWritePerMTok
    + usage.cacheReadTokens * prices.cacheReadPerMTok
    + usage.outputTokens * prices.outputPerMTok
  ) / 1_000_000;
}

/**
 * Relative prices of the cache buckets against the base input price, for
 * cost in "uncached-equivalent tokens" when no dollar prices are given.
 * Defaults follow Anthropic's published ratios (5-minute cache write 1.25x,
 * cache read 0.1x); pass the ratios for another provider when needed.
 */
export interface CacheRatios {
  write: number;
  read: number;
}

/** Default cache price ratios (write 1.25x, read 0.1x of base input). */
export const DEFAULT_CACHE_RATIOS: Readonly<CacheRatios> = { write: 1.25, read: 0.1 };

/** Input cost of `usage` in uncached-equivalent tokens (output excluded). */
export function uncachedEquivalentInput(usage: Usage, ratios: CacheRatios = DEFAULT_CACHE_RATIOS): number {
  return usage.inputTokens + usage.cacheWriteTokens * ratios.write + usage.cacheReadTokens * ratios.read;
}

/**
 * Mulberry32: a small seeded PRNG returning floats in [0, 1). Same seed,
 * same stream, on every platform.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point estimate with a percentile bootstrap confidence interval. */
export interface Estimate {
  estimate: number;
  low: number;
  high: number;
  /** Resamples drawn. */
  iterations: number;
}

/** Options shared by the bootstrap functions. */
export interface BootstrapOpts {
  /** Resamples. Default 5000. */
  iterations?: number;
  /** Two-sided level, e.g. 0.05 for a 95% interval. Default 0.05. */
  alpha?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
}

/** Lower and upper ends of a percentile interval. */
interface Interval {
  low: number;
  high: number;
}

function percentileInterval(samples: number[], alpha: number): Interval {
  const sorted = [...samples].sort((x, y) => x - y);
  const lowIdx = Math.max(0, Math.floor((alpha / 2) * sorted.length));
  const highIdx = Math.min(sorted.length - 1, Math.ceil((1 - alpha / 2) * sorted.length) - 1);
  return { low: sorted[lowIdx]!, high: sorted[highIdx]! };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Paired bootstrap for the mean of per-task differences (treatment minus
 * control on the same task). An interval that excludes zero is the bar for
 * calling a difference real.
 */
export function pairedBootstrap(diffs: number[], opts: BootstrapOpts = {}): Estimate {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  if (diffs.length === 0) return { estimate: 0, low: 0, high: 0, iterations: 0 };
  const rand = seededRandom(opts.seed ?? 1);
  const n = diffs.length;
  const samples: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rand() * n)]!;
    samples.push(s / n);
  }
  return { estimate: mean(diffs), ...percentileInterval(samples, alpha), iterations };
}

/**
 * Cluster bootstrap for the mean of per-task differences: resamples whole
 * clusters (for example all tasks from one repository), because tasks in a
 * cluster share causes and are not independent draws.
 */
export function clusteredPairedBootstrap(
  diffsByCluster: ReadonlyMap<string, number[]>,
  opts: BootstrapOpts = {},
): Estimate {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const clusters = [...diffsByCluster.values()].filter((c) => c.length > 0);
  const all = clusters.flat();
  if (all.length === 0) return { estimate: 0, low: 0, high: 0, iterations: 0 };
  const rand = seededRandom(opts.seed ?? 1);
  const k = clusters.length;
  const samples: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < k; i++) {
      const c = clusters[Math.floor(rand() * k)]!;
      for (const d of c) sum += d;
      count += c.length;
    }
    samples.push(count === 0 ? 0 : sum / count);
  }
  return { estimate: mean(all), ...percentileInterval(samples, alpha), iterations };
}

/** One task's outcome in one arm, for {@link costPerResolvedDelta}. */
export interface ArmOutcome {
  /** Dollars (or uncached-equivalent tokens) spent on the task. */
  cost: number;
  /** Whether the task was resolved. */
  resolved: boolean;
}

/** Result of {@link costPerResolvedDelta}. */
export interface CostPerResolvedDelta {
  control: number;
  treatment: number;
  /** treatment minus control, with its interval. */
  delta: Estimate;
  /** (treatment minus control) / control, with its interval. Negative is a saving. */
  relative: Estimate;
}

function costPerResolved(outcomes: ArmOutcome[]): number {
  const resolved = outcomes.filter((o) => o.resolved).length;
  const cost = outcomes.reduce((s, o) => s + o.cost, 0);
  return resolved === 0 ? Number.POSITIVE_INFINITY : cost / resolved;
}

/**
 * Cost per resolved task in two arms run on the same tasks, with a paired
 * bootstrap over tasks (a task is resampled with both of its arm outcomes).
 * `control[i]` and `treatment[i]` must be the same task. Resamples in which
 * an arm resolves nothing are dropped; `iterations` reports how many were
 * kept.
 */
export function costPerResolvedDelta(
  control: ArmOutcome[],
  treatment: ArmOutcome[],
  opts: BootstrapOpts = {},
): CostPerResolvedDelta {
  if (control.length !== treatment.length) {
    throw new Error('control and treatment must list the same tasks in the same order');
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const c = costPerResolved(control);
  const t = costPerResolved(treatment);
  const rand = seededRandom(opts.seed ?? 1);
  const n = control.length;
  const deltas: number[] = [];
  const relatives: number[] = [];
  for (let b = 0; b < iterations && n > 0; b++) {
    const cs: ArmOutcome[] = [];
    const ts: ArmOutcome[] = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n);
      cs.push(control[j]!);
      ts.push(treatment[j]!);
    }
    const cc = costPerResolved(cs);
    const tt = costPerResolved(ts);
    if (!Number.isFinite(cc) || !Number.isFinite(tt)) continue;
    deltas.push(tt - cc);
    relatives.push((tt - cc) / cc);
  }
  const finite = Number.isFinite(c) && Number.isFinite(t);
  const empty = { low: Number.NaN, high: Number.NaN };
  return {
    control: c,
    treatment: t,
    delta: {
      estimate: finite ? t - c : Number.NaN,
      ...(deltas.length > 0 ? percentileInterval(deltas, alpha) : empty),
      iterations: deltas.length,
    },
    relative: {
      estimate: finite ? (t - c) / c : Number.NaN,
      ...(relatives.length > 0 ? percentileInterval(relatives, alpha) : empty),
      iterations: relatives.length,
    },
  };
}

/**
 * pass@k: share of tasks with at least one success in their first k runs.
 * NaN when no task has k runs (not measured, which is not the same as 0).
 */
export function passAtK(runsByTask: boolean[][], k: number): number {
  const eligible = runsByTask.filter((r) => r.length >= k);
  if (eligible.length === 0) return Number.NaN;
  return eligible.filter((r) => r.slice(0, k).some(Boolean)).length / eligible.length;
}

/**
 * pass^k: share of tasks whose first k runs all succeed (consistency).
 * NaN when no task has k runs.
 */
export function passHatK(runsByTask: boolean[][], k: number): number {
  const eligible = runsByTask.filter((r) => r.length >= k);
  if (eligible.length === 0) return Number.NaN;
  return eligible.filter((r) => r.slice(0, k).every(Boolean)).length / eligible.length;
}

/** All units of one family (tasks by seeds), resampled as one block so seeds stay together. */
export type Family<T> = readonly T[];

/** One repository's families; a task with no lesson is a family of one. */
export type Repository<T> = readonly Family<T>[];

/** An {@link Estimate} with a two-sided p-value from the same resamples. */
export interface TestedEstimate extends Estimate {
  /** 2 x min(share <= null, share >= null), capped at 1; NaN with fewer than two repositories. */
  readonly p: number;
  /** Non-finite resamples, dropped; `iterations + dropped` is the number requested. */
  readonly dropped: number;
  /** The null the p-value tested against; {@link verdict} reads its sides from here. */
  readonly nullValue: number;
}

/** Options for {@link twoLevelBootstrap}. */
export interface TwoLevelOpts extends BootstrapOpts {
  /** Resamples. Default 10,000. */
  readonly iterations?: number;
  /** Value the p-value tests against: 0 for differences, 1 for ratios. Default 0. */
  readonly nullValue?: number;
}

function notANumber(nullValue: number, dropped: number): TestedEstimate {
  const nan = Number.NaN;
  return { estimate: nan, low: nan, high: nan, p: nan, iterations: 0, dropped, nullValue };
}

function resampleUnits<T>(repos: readonly Repository<T>[], rand: () => number): T[] {
  const units: T[] = [];
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[Math.floor(rand() * repos.length)]!;
    for (let j = 0; j < repo.length; j++) {
      for (const unit of repo[Math.floor(rand() * repo.length)]!) units.push(unit);
    }
  }
  return units;
}

// Inclusive on both sides, as the p-value is worded; float noise around the null breaks a tie.
function twoSidedP(samples: readonly number[], nullValue: number): number {
  let below = 0;
  let above = 0;
  for (const s of samples) {
    if (s <= nullValue) below++;
    if (s >= nullValue) above++;
  }
  return Math.min(1, (2 * Math.min(below, above)) / samples.length);
}

/** Resamples repositories, then families inside each; only the repository draw carries a shared-store fault.
 * The statistic never uses the PRNG, so a second call on one seed draws the same resamples. */
export function twoLevelBootstrap<T>(
  repos: readonly Repository<T>[],
  statistic: (units: readonly T[]) => number,
  opts: TwoLevelOpts = {},
): TestedEstimate {
  const requested = opts.iterations ?? DEFAULT_TWO_LEVEL_ITERATIONS;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new RangeError(`iterations must be a positive integer, got ${requested}`);
  }
  const nullValue = opts.nullValue ?? 0;
  const kept = repos.map((r) => r.filter((f) => f.length > 0)).filter((r) => r.length > 0);
  if (kept.length === 0) return notANumber(nullValue, 0);
  const rand = seededRandom(opts.seed ?? 1);
  const samples: number[] = [];
  for (let b = 0; b < requested; b++) {
    const value = statistic(resampleUnits(kept, rand));
    if (Number.isFinite(value)) samples.push(value);
  }
  const dropped = requested - samples.length;
  if (samples.length === 0) return notANumber(nullValue, dropped);
  const estimate = statistic(kept.flatMap((r) => r.flat()));
  const p = kept.length < 2 ? Number.NaN : twoSidedP(samples, nullValue);
  const interval = percentileInterval(samples, opts.alpha ?? DEFAULT_ALPHA);
  return { estimate, ...interval, p, iterations: samples.length, dropped, nullValue };
}

/** Holm step-down in input order; the family size is `ps.length`, as preregistered.
 * A NaN stays NaN but ranks as 1, so it never loosens the others; a finite p outside [0, 1] throws. */
export function holmAdjust(ps: readonly number[]): number[] {
  for (const p of ps) {
    if (!Number.isNaN(p) && !(p >= 0 && p <= 1)) throw new RangeError(`p-value out of range: ${p}`);
  }
  const ranked = ps
    .map((p, index) => ({ index, key: Number.isNaN(p) ? 1 : p }))
    .sort((a, b) => a.key - b.key || a.index - b.index);
  const adjusted = Array.from({ length: ps.length }, () => Number.NaN);
  let running = 0;
  ranked.forEach(({ index, key }, rank) => {
    running = Math.max(running, (ps.length - rank) * key);
    if (!Number.isNaN(ps[index]!)) adjusted[index] = Math.min(1, running);
  });
  return adjusted;
}

/** One of the four mutually exclusive outcomes the preregistration allows per hypothesis. */
export type Verdict = 'loss' | 'win' | 'tie' | 'inconclusive';

/** What a hypothesis needs to be read; see {@link verdict}. */
export interface VerdictSpec {
  /** Direction that favours the treatment arm. */
  readonly helpful: 'lower' | 'higher';
  /** Inclusive band the interval must sit inside for a tie. */
  readonly tieBand: readonly [number, number];
  /** An estimate on this value or beyond it, on the helpful side, reaches the minimum effect. */
  readonly minimumEffectAt: number;
  /** Default 0.05. */
  readonly alpha?: number;
}

/** A verdict, plus whether a win reaches the minimum effect (a win below it is a small win). */
export interface VerdictResult {
  readonly verdict: Verdict;
  readonly reachesMinimum: boolean;
}

/** Checks in the preregistered order; the null comes from `e.nullValue`, so p and sides cannot disagree.
 * A NaN estimate, p or bound is inconclusive, since a win or loss cannot be ruled out. */
export function verdict(e: TestedEstimate, adjustedP: number, spec: VerdictSpec): VerdictResult {
  const inconclusive: VerdictResult = { verdict: 'inconclusive', reachesMinimum: false };
  if ([adjustedP, e.estimate, e.low, e.high].some(Number.isNaN)) return inconclusive;
  const nullValue = e.nullValue;
  const lowerIsHelpful = spec.helpful === 'lower';
  if (adjustedP < (spec.alpha ?? DEFAULT_ALPHA)) {
    const helpfulSide = lowerIsHelpful ? e.estimate < nullValue : e.estimate > nullValue;
    const harmfulSide = lowerIsHelpful ? e.estimate > nullValue : e.estimate < nullValue;
    if (harmfulSide) return { verdict: 'loss', reachesMinimum: false };
    if (helpfulSide) {
      const reaches = lowerIsHelpful ? e.estimate <= spec.minimumEffectAt : e.estimate >= spec.minimumEffectAt;
      return { verdict: 'win', reachesMinimum: reaches };
    }
  }
  const insideBand = e.low >= spec.tieBand[0] && e.high <= spec.tieBand[1];
  return insideBand ? { verdict: 'tie', reachesMinimum: false } : inconclusive;
}

/** A win must hold under both codings of not-applicable, while a loss under either is reported. */
export function combineCodings(a: VerdictResult, b: VerdictResult): VerdictResult {
  if (a.verdict === 'loss' || b.verdict === 'loss') return { verdict: 'loss', reachesMinimum: false };
  if (a.verdict === 'win' && b.verdict === 'win') {
    return { verdict: 'win', reachesMinimum: a.reachesMinimum && b.reachesMinimum };
  }
  if (a.verdict === 'tie' && b.verdict === 'tie') return { verdict: 'tie', reachesMinimum: false };
  return { verdict: 'inconclusive', reachesMinimum: false };
}

/** Outcome of the harm gate; see {@link harmGate}. */
export interface HarmGate {
  readonly pass: boolean;
  readonly costOk: boolean;
  readonly resolveOk: boolean;
}

/** Cost ratio's upper bound below 1.10, resolve difference's lower bound (a fraction) above -0.05.
 * Both estimates must use alpha 0.05, the conservative reading of "upper 95% bound"; a NaN bound fails. */
export function harmGate(costRatio: Estimate, resolveDiff: Estimate): HarmGate {
  const costOk = costRatio.high < 1.1;
  const resolveOk = resolveDiff.low > -0.05;
  return { pass: costOk && resolveOk, costOk, resolveOk };
}
