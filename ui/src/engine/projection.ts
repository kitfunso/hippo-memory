export function projectTo2D(vectors: Record<string, number[]>) {
  const result3d = projectTo3D(vectors);
  const out: Record<string, [number, number]> = {};
  for (const [id, [x, y]] of Object.entries(result3d)) {
    out[id] = [x, y];
  }
  return out;
}

export function projectTo3D(
  vectors: Record<string, number[]>,
): Record<string, [number, number, number]> {
  const ids = Object.keys(vectors);
  if (ids.length === 0) return {};
  if (ids.length === 1) return Object.fromEntries<[number, number, number]>([[ids[0], [0, 0, 0]]]);

  const dim = vectors[ids[0]].length;
  const n = ids.length;

  const mean = new Float64Array(dim);
  for (const id of ids) {
    const v = vectors[id];
    for (let j = 0; j < dim; j++) mean[j] += v[j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= n;

  const centered = new Array<Float64Array>(n);
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(dim);
    const v = vectors[ids[i]];
    for (let j = 0; j < dim; j++) row[j] = v[j] - mean[j];
    centered[i] = row;
  }

  const findComponent = (data: Float64Array[]): Float64Array => {
    const w = new Float64Array(dim);
    for (let j = 0; j < dim; j++) w[j] = Math.random() - 0.5;
    for (let iter = 0; iter < 100; iter++) {
      const next = new Float64Array(dim);
      for (let i = 0; i < n; i++) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += data[i][j] * w[j];
        for (let j = 0; j < dim; j++) next[j] += data[i][j] * dot;
      }
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += next[j] * next[j];
      norm = Math.sqrt(norm);
      if (norm < 1e-12) return new Float64Array(dim);
      for (let j = 0; j < dim; j++) w[j] = next[j] / norm;
    }
    return w;
  };

  const deflate = (data: Float64Array[], pc: Float64Array): Float64Array[] => {
    return data.map((row) => {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += row[j] * pc[j];
      const out = new Float64Array(dim);
      for (let j = 0; j < dim; j++) out[j] = row[j] - dot * pc[j];
      return out;
    });
  };

  const orthogonalize = (v: Float64Array, against: Float64Array[]): Float64Array => {
    const out = new Float64Array(v);
    for (const u of against) {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += out[j] * u[j];
      for (let j = 0; j < dim; j++) out[j] -= dot * u[j];
    }
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += out[j] * out[j];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) for (let j = 0; j < dim; j++) out[j] /= norm;
    return out;
  };

  const pc1 = findComponent(centered);
  const d1 = deflate(centered, pc1);
  const pc2 = orthogonalize(findComponent(d1), [pc1]);
  const d2 = deflate(d1, pc2);
  const pc3 = orthogonalize(findComponent(d2), [pc1, pc2]);

  const components = [pc1, pc2, pc3];
  const coords = new Array<[number, number, number]>(n);

  for (let i = 0; i < n; i++) {
    const row = centered[i];
    const vals: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let dot = 0;
      for (let j = 0; j < dim; j++) dot += row[j] * components[c][j];
      vals[c] = dot;
    }
    coords[i] = vals;
  }

  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const a = Math.abs(coords[i][c]);
      if (a > maxAbs) maxAbs = a;
    }
  }

  const result: Record<string, [number, number, number]> = Object.fromEntries(
    ids.map(
      (id, i): [string, [number, number, number]] =>
        maxAbs < 1e-12
          ? [id, [0, 0, 0]]
          : [id, [coords[i][0] / maxAbs, coords[i][1] / maxAbs, coords[i][2] / maxAbs]],
    ),
  );
  return result;
}
