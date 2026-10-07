import type { ProjectSummary } from "../../../types";

/** A rectangle in layout space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One project's tile in layout (camera 1) coordinates. */
export interface Tile extends Rect {
  key: string;
  /** Index into the projects array the layout was built from. */
  index: number;
}

/** Squarified treemap (Bruls et al.): lays `vals` into the box, one rect per value in input order. */
export function squarify(vals: readonly number[], x: number, y: number, w: number, h: number): Rect[] {
  const n = vals.length;
  const out: Rect[] = [];
  if (!n) return out;
  let total = 0;
  for (const v of vals) total += v;
  const a = vals.map((v) => (v * (w * h)) / total);
  const ratio = (s: number, mn: number, mx: number, sh: number) => {
    const s2 = s * s;
    const w2 = sh * sh;
    return Math.max((w2 * mx) / s2, s2 / (w2 * mn));
  };
  let i = 0;
  while (i < n) {
    const sh = Math.min(w, h);
    if (sh <= 0) {
      for (; i < n; i++) out.push({ x, y, w: 0, h: 0 });
      break;
    }
    let sum = a[i];
    let mn = a[i];
    let mx = a[i];
    let worst = ratio(sum, mn, mx, sh);
    let j = i + 1;
    while (j < n) {
      const s2 = sum + a[j];
      const mn2 = Math.min(mn, a[j]);
      const mx2 = Math.max(mx, a[j]);
      const w2 = ratio(s2, mn2, mx2, sh);
      if (w2 > worst) break;
      sum = s2;
      mn = mn2;
      mx = mx2;
      worst = w2;
      j++;
    }
    const th = sum / sh;
    if (w >= h) {
      let yy = y;
      for (let q = i; q < j; q++) {
        const hh = a[q] / th;
        out.push({ x, y: yy, w: th, h: hh });
        yy += hh;
      }
      x += th;
      w -= th;
    } else {
      let xx = x;
      for (let q = i; q < j; q++) {
        const ww = a[q] / th;
        out.push({ x: xx, y, w: ww, h: th });
        xx += ww;
      }
      y += th;
      h -= th;
    }
    i = j;
  }
  return out;
}

const PAD = 8;

/** Flat layout: one squarified level, tile order as given (see treemapOrder). */
export function layoutTiles(projects: readonly ProjectSummary[], width: number, height: number): Tile[] {
  const live = projects.map((p, index) => ({ p, index })).filter(({ p }) => p.live > 0);
  if (live.length === 0 || width < 10 || height < 10) return [];
  const rects = squarify(live.map(({ p }) => p.live), PAD, PAD, width - 2 * PAD, height - 2 * PAD);
  return live.map(({ p, index }, k) => {
    const r = rects[k];
    return { key: p.key, index, x: r.x + 1, y: r.y + 1, w: Math.max(0, r.w - 2), h: Math.max(0, r.h - 2) };
  });
}

/** Projects in treemap order: named projects by size, then Global, then Unassigned. */
export function treemapOrder(projects: readonly ProjectSummary[]): ProjectSummary[] {
  const rank = (p: ProjectSummary) => (p.kind === "project" ? 0 : p.kind === "global" ? 1 : 2);
  return projects
    .filter((p) => p.live > 0)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.live - a.live || a.name.localeCompare(b.name));
}
