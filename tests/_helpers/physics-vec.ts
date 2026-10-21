// Allocating vector helpers, the reference the in-place physics step is held to bit for bit.
import { vecNorm, vecScale } from '../../src/base/rank/physics.js';

export function vecAdd(a: number[], b: number[]): number[] {
  const out = a.slice();
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

export function vecClampMagnitude(v: number[], maxMag: number): number[] {
  const mag = vecNorm(v);
  if (mag <= maxMag) return v;
  return vecScale(v, maxMag / mag);
}
