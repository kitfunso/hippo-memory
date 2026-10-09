// Vectors from a store worker as one buffer: it moves to the server thread with no copy, where a Map of typed arrays is copied value by value.

/** Every vector end to end in `buffer` as Float32, `dims[i]` numbers for `ids[i]`. */
export interface VectorPack {
  readonly ids: readonly string[];
  readonly dims: readonly number[];
  readonly buffer: ArrayBuffer;
}

/** A pack on the thread that built it, so the reply that carries it knows which buffer to move. */
export class PackedVectors implements VectorPack {
  constructor(readonly ids: readonly string[], readonly dims: readonly number[], readonly buffer: ArrayBuffer) {}
}

export function packVectors(vectors: ReadonlyMap<string, Float32Array>): PackedVectors {
  let total = 0;
  for (const vector of vectors.values()) total += vector.length;
  const buffer = new ArrayBuffer(total * Float32Array.BYTES_PER_ELEMENT);
  const floats = new Float32Array(buffer);
  const dims: number[] = [];
  let at = 0;
  for (const vector of vectors.values()) {
    floats.set(vector, at);
    at += vector.length;
    dims.push(vector.length);
  }
  return new PackedVectors([...vectors.keys()], dims, buffer);
}

function eachVector<V>(pack: VectorPack, valueOf: (view: Float32Array) => V): Map<string, V> {
  const floats = new Float32Array(pack.buffer);
  const out = new Map<string, V>();
  let at = 0;
  pack.ids.forEach((id, i) => {
    const end = at + (pack.dims[i] ?? 0);
    out.set(id, valueOf(floats.subarray(at, end)));
    at = end;
  });
  return out;
}

/** Each value views its own stretch of the pack's one buffer. */
export function vectorViewsOf(pack: VectorPack): Map<string, Float32Array> {
  return eachVector(pack, (view) => view);
}

export function vectorCopiesOf(pack: VectorPack): Map<string, number[]> {
  return eachVector(pack, (view) => Array.from(view));
}
