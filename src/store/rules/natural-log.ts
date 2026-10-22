// ln(x) rounded to the nearest double. V8's Math.log can land one unit in the last place off where the C library under
// SQLite's FTS5 does not, and bm25() scores are compared exactly, so this works in double-double precision.

/** A value as an unevaluated sum hi + lo, with |lo| at most half a unit in the last place of hi. */
type Pair = readonly [number, number];

const SPLITTER = 134217729; // 2^27 + 1, which splits a double into two halves whose products are exact.
const LN2: Pair = [0.6931471805599453, 2.3190468138462996e-17];

function quickSum(a: number, b: number): Pair {
  const s = a + b;
  return [s, b - (s - a)];
}

function twoSum(a: number, b: number): Pair {
  const s = a + b;
  const v = s - a;
  return [s, a - (s - v) + (b - v)];
}

function halves(a: number): Pair {
  const c = SPLITTER * a;
  const hi = c - (c - a);
  return [hi, a - hi];
}

function twoProduct(a: number, b: number): Pair {
  const p = a * b;
  const [ah, al] = halves(a);
  const [bh, bl] = halves(b);
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

function add(x: Pair, y: Pair): Pair {
  const [s, e] = twoSum(x[0], y[0]);
  return quickSum(s, e + x[1] + y[1]);
}

function times(x: Pair, y: Pair): Pair {
  const [p, e] = twoProduct(x[0], y[0]);
  return quickSum(p, e + x[0] * y[1] + x[1] * y[0]);
}

function divide(x: Pair, y: Pair): Pair {
  const q = x[0] / y[0];
  const rest = add(x, times(y, [-q, 0]));
  return quickSum(q, rest[0] / y[0]);
}

/** ln of a positive finite x: x = m * 2^e with m near 1, then ln m = 2 atanh((m - 1) / (m + 1)) by its series. */
export function naturalLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Math.log(x);
  let e = Math.round(Math.log2(x));
  let m = x / 2 ** e;
  if (m > Math.SQRT2) {
    e += 1;
    m /= 2;
  } else if (m < Math.SQRT1_2) {
    e -= 1;
    m *= 2;
  }
  const s = divide([m - 1, 0], twoSum(m, 1));
  const s2 = times(s, s);
  let power = s;
  let series = s;
  for (let k = 3; k < 80 && Math.abs(power[0]) > Math.abs(series[0]) * 1e-34; k += 2) {
    power = times(power, s2);
    series = add(series, divide(power, [k, 0]));
  }
  const lnM = times(series, [2, 0]);
  return add(times(LN2, [e, 0]), lnM)[0];
}
