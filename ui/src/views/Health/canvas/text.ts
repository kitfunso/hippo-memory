/** Canvas text fitting for tile labels; ported from the mockup. */

export const F_NAME = '600 12px "IBM Plex Sans", system-ui, sans-serif';
export const F_NUM = '400 12px "IBM Plex Mono", ui-monospace, monospace';

const fitCache = new Map<string, string>();

/** Drops cached fits; call when fonts finish loading, because widths change. */
export function clearFitCache(): void {
  fitCache.clear();
}

/** `s` cut with an ellipsis to fit `maxW`, or "" when not even one character fits. */
export function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  const key = `${ctx.font}|${s}|${Math.floor(maxW)}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;
  let out: string;
  if (ctx.measureText(s).width <= maxW) {
    out = s;
  } else {
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(s.slice(0, mid) + "…").width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    out = lo > 0 ? s.slice(0, lo) + "…" : "";
  }
  if (fitCache.size > 4000) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

/** A name cut to a stub reads as noise: keep it whole, or cut to a long enough prefix, else drop it. */
export function tileName(ctx: CanvasRenderingContext2D, name: string, maxW: number): string {
  ctx.font = F_NAME;
  if (ctx.measureText(name).width <= maxW) return name;
  const v = fitText(ctx, name, maxW);
  return v === name || (v.length >= 9 && v.length >= name.length * 0.7) ? v : "";
}

/** Numbers never truncate: the first variant that fits whole, else nothing. */
export function firstFit(ctx: CanvasRenderingContext2D, font: string, maxW: number, options: readonly string[]): string {
  ctx.font = font;
  return options.find((s) => ctx.measureText(s).width <= maxW) ?? "";
}
