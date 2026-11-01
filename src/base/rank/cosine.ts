// The vector math every ranking site shares (embeddings, the vector index): one dot
// product, one length and one rule for a vector too short to have a direction.

/** A vector shorter than this has no direction: it normalises to nothing and scores 0 against
 * any other. */
export const ZERO_NORM = 1e-10;

// Four running sums, which V8 runs faster than one: vector index inserts spend most of their
// time here.
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  const whole = a.length & ~3;
  let i = 0;
  for (; i < whole; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  for (; i < a.length; i++) s0 += a[i] * b[i];
  return s0 + s1 + (s2 + s3);
}

export function norm(v: ArrayLike<number>): number {
  return Math.sqrt(dot(v, v));
}

/** Cosine over any indexable vectors (a Float32 view scores as its number[] copy); 0 for empty,
 * mismatched or directionless input. */
export function cosineOf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let products = 0;
  let squaresA = 0;
  let squaresB = 0;
  for (let i = 0; i < a.length; i++) {
    products += a[i] * b[i];
    squaresA += a[i] * a[i];
    squaresB += b[i] * b[i];
  }

  const lengthA = Math.sqrt(squaresA);
  const lengthB = Math.sqrt(squaresB);
  if (lengthA < ZERO_NORM || lengthB < ZERO_NORM) return 0;
  // Clamp to [-1, 1] to handle floating point drift
  return Math.min(1, Math.max(-1, products / (lengthA * lengthB)));
}

/** Cosine of `v` to a query of length `queryNorm`, summed in float64 so the vector index and a
 * full scan of the rows rank alike; null for a `v` with no direction. */
export function cosineToQuery(
  query: ArrayLike<number>,
  queryNorm: number,
  v: ArrayLike<number>,
): number | null {
  let products = 0;
  let squares = 0;
  for (let i = 0; i < v.length; i++) {
    products += query[i] * v[i];
    squares += v[i] * v[i];
  }
  const length = Math.sqrt(squares);
  return length < ZERO_NORM ? null : products / (queryNorm * length);
}
