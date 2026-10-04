import type { Band } from "../../../types";

const RISK_STOPS: readonly (readonly [number, string])[] = [
  [0, "#e8edf4"],
  [0.1, "#fbe3cf"],
  [0.2, "#f9bf8f"],
  [0.3, "#f29256"],
  [0.4, "#dc652f"],
  [0.5, "#b5451b"],
  [0.6, "#83300f"],
];

/** Fill and label colours of a tile for one at-risk share. */
export interface RiskColor {
  css: string;
  /** Label colour chosen for contrast on `css`. */
  ink: string;
  sub: string;
}

type Rgb = [number, number, number];

const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const INK_DARK_LUM = luminance([17, 24, 39]);

function buildLut(): RiskColor[] {
  const out: RiskColor[] = [];
  for (let k = 0; k <= 60; k++) {
    const x = k / 100;
    let a = RISK_STOPS[0];
    let b = RISK_STOPS[RISK_STOPS.length - 1];
    for (let s = 0; s < RISK_STOPS.length - 1; s++) {
      if (x >= RISK_STOPS[s][0] && x <= RISK_STOPS[s + 1][0]) {
        a = RISK_STOPS[s];
        b = RISK_STOPS[s + 1];
        break;
      }
    }
    const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
    const ca = hexRgb(a[1]);
    const cb = hexRgb(b[1]);
    const mix = (j: 0 | 1 | 2) => Math.round(ca[j] + (cb[j] - ca[j]) * t);
    const c: Rgb = [mix(0), mix(1), mix(2)];
    const lum = luminance(c);
    const dark = (lum + 0.05) / (INK_DARK_LUM + 0.05) >= 1.05 / (lum + 0.05);
    out.push({
      css: `rgb(${c[0]},${c[1]},${c[2]})`,
      ink: dark ? "#111827" : "#ffffff",
      sub: dark ? "rgba(17,24,39,.78)" : "rgba(255,255,255,.86)",
    });
  }
  return out;
}

const RISK_LUT = buildLut();

/** Sequential colour for an at-risk share (0..1); shares above 0.6 clamp to the darkest step. */
export const riskColor = (share: number): RiskColor => RISK_LUT[Math.min(60, Math.max(0, Math.round(share * 100)))];

/** Bands in cell order: pinned, strong, fading, at risk. */
export const BAND_ORDER: readonly Band[] = ["pinned", "strong", "fading", "atRisk"];

/** Cell colour per band, same order as BAND_ORDER. */
export const BAND_RGB: readonly Rgb[] = [
  [30, 58, 138],
  [47, 111, 237],
  [168, 192, 242],
  [232, 89, 12],
];

/** Display name per band, same order as BAND_ORDER. */
export const BAND_NAME: readonly string[] = ["Pinned", "Strong", "Fading", "At risk"];

/** Fixed lightening per band: the wire carries counts, not each memory's strength. */
export const BAND_TINT: readonly number[] = [0, 0.1, 0.3, 0];
