import type { ProjectSummary, ScatterGrid, ScatterPoints } from "../../../types";
import { clamp, fmt } from "../format";
import { F_NUM } from "./text";

/** Plot margins in CSS px, as the mockup. */
export const MARGIN = { l: 46, r: 14, t: 12, b: 30 } as const;

/** Layer colours in wire order (buffer, episodic, semantic, trace). */
export const LAYER_COL: readonly string[] = ["#7a8597", "#2f6fed", "#8b3fd9", "#0f8b8d"];

const AGE_TICKS = [0, 1, 7, 30, 90, 365, 720];
const STRENGTH_TICKS = [0, 0.2, 0.5, 1];
const GRID_COLS = 64;
const GRID_ROWS = 32;
const HIT_RADIUS = 8;

/** Canvas size and the log-age span of the plot. */
export interface Plot {
  W: number;
  H: number;
  maxLog: number;
}

/** A brush rectangle in data units: age in days, strength 0..1. */
export interface Brush {
  a0: number;
  a1: number;
  s0: number;
  s1: number;
}

/** One density cell under the pointer. */
export interface CellHit {
  col: number;
  row: number;
  count: number;
  age0: number;
  age1: number;
  s0: number;
  s1: number;
}

const plotW = (p: Plot): number => p.W - MARGIN.l - MARGIN.r;
const plotH = (p: Plot): number => p.H - MARGIN.t - MARGIN.b;

/** Log-age span: grid mode must match the server's column binning, points mode keeps the mockup's headroom. */
export function maxLogFor(data: ScatterPoints | ScatterGrid): number {
  if (data.mode === "grid") return Math.max(1e-6, Math.log10(data.maxAgeDays + 1));
  return Math.log10(Math.max(30, data.maxAgeDays) * 1.25 + 1);
}

/** X pixel of an age in days. */
export const plotX = (p: Plot, age: number): number => MARGIN.l + (Math.log10(age + 1) / p.maxLog) * plotW(p);

/** Y pixel of a strength. */
export const plotY = (p: Plot, s: number): number => MARGIN.t + (1 - s) * plotH(p);

/** Age in days at an x pixel, clamped to the plot. */
export const ageAt = (p: Plot, x: number): number => Math.pow(10, clamp((x - MARGIN.l) / plotW(p), 0, 1) * p.maxLog) - 1;

/** Strength at a y pixel, clamped to the plot. */
export const strengthAt = (p: Plot, y: number): number => 1 - clamp((y - MARGIN.t) / plotH(p), 0, 1);

/** The brush for a drag between two pixel points, clamped to the plot. */
export function brushFromDrag(p: Plot, x0: number, y0: number, x1: number, y1: number): Brush {
  const xa = clamp(Math.min(x0, x1), MARGIN.l, p.W - MARGIN.r);
  const xb = clamp(Math.max(x0, x1), MARGIN.l, p.W - MARGIN.r);
  const ya = clamp(Math.min(y0, y1), MARGIN.t, p.H - MARGIN.b);
  const yb = clamp(Math.max(y0, y1), MARGIN.t, p.H - MARGIN.b);
  return { a0: ageAt(p, xa), a1: ageAt(p, xb), s0: strengthAt(p, yb), s1: strengthAt(p, ya) };
}

/** Index of the nearest visible point within the hit radius, or -1; geometry only, so it works without a canvas. */
export function hitPoint(data: ScatterPoints, on: readonly boolean[], p: Plot, mx: number, my: number): number {
  let best = -1;
  let bd = HIT_RADIUS * HIT_RADIUS;
  for (let k = 0; k < data.points.length; k++) {
    const [age, s, layer] = data.points[k];
    if (!on[layer]) continue;
    const d = (plotX(p, age) - mx) ** 2 + (plotY(p, s) - my) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** The density cell under a pixel (counts summed over the layers that are on), or null outside the plot. */
export function hitCell(data: ScatterGrid, on: readonly boolean[], p: Plot, mx: number, my: number): CellHit | null {
  if (mx < MARGIN.l || mx > p.W - MARGIN.r || my < MARGIN.t || my > p.H - MARGIN.b) return null;
  const col = Math.min(GRID_COLS - 1, Math.floor(((mx - MARGIN.l) / plotW(p)) * GRID_COLS));
  const row = Math.min(GRID_ROWS - 1, Math.floor(strengthAt(p, my) * GRID_ROWS));
  return { col, row, count: cellCount(data, on, col, row), age0: colAge(p, col), age1: colAge(p, col + 1), s0: row / GRID_ROWS, s1: (row + 1) / GRID_ROWS };
}

const colAge = (p: Plot, col: number): number => Math.pow(10, (col / GRID_COLS) * p.maxLog) - 1;

function cellCount(data: ScatterGrid, on: readonly boolean[], col: number, row: number): number {
  let n = 0;
  for (let l = 0; l < data.cells.length; l++) if (on[l]) n += data.cells[l][row * GRID_COLS + col] ?? 0;
  return n;
}

const LOW: readonly [number, number, number] = [96, 145, 243];
const HIGH: readonly [number, number, number] = [30, 58, 138];

/** Density colour for t in 0..1; the lowest step already holds 3:1 against the white card, so no non-empty cell fades out. */
export function densityRgb(t: number): [number, number, number] {
  const u = clamp(t, 0, 1);
  const mix = (i: 0 | 1 | 2): number => Math.round(LOW[i] + (HIGH[i] - LOW[i]) * u);
  return [mix(0), mix(1), mix(2)];
}

/** Position on the log ramp for a cell count against the busiest cell. */
export const densityStep = (count: number, max: number): number => (max <= 1 ? 0 : Math.log(count) / Math.log(max));

/** The most memories any one cell holds with the given layers on. */
export function maxCell(data: ScatterGrid, on: readonly boolean[]): number {
  let max = 0;
  for (let row = 0; row < GRID_ROWS; row++) for (let col = 0; col < GRID_COLS; col++) max = Math.max(max, cellCount(data, on, col, row));
  return max;
}

/** The text the scatter's accessible description carries, built from the project payload. */
export function scatterSummary(s: ProjectSummary, maxAgeDays: number): string {
  const b = s.bands;
  return `${fmt(s.live)} memories. Age 0 to ${fmt(maxAgeDays)} days. ${fmt(b.atRisk)} at risk, ${fmt(b.fading)} fading, ${fmt(b.strong)} strong, ${fmt(b.pinned)} pinned.`;
}

/** Marker size in px for n points, as the mockup's ladder without its 4,000-point tiers. */
export const markerSize = (n: number): number => (n > 600 ? 7 : n > 40 ? 8 : 11);

function marker(ctx: CanvasRenderingContext2D, layer: number, x: number, y: number, size: number): void {
  const r = size / 2;
  if (layer === 0) {
    ctx.rect(x - r * 0.78, y - r * 0.78, r * 1.56, r * 1.56);
  } else if (layer === 1) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, 7);
  } else if (layer === 2) {
    const half = 1.75 * r * 0.62;
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + half, y + r * 0.75);
    ctx.lineTo(x - half, y + r * 0.75);
    ctx.closePath();
  } else {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  }
}

/** Inputs of one scatter draw. */
export interface ScatterScene {
  plot: Plot;
  dpr: number;
  data: ScatterPoints | ScatterGrid;
  on: readonly boolean[];
}

function drawAxes(ctx: CanvasRenderingContext2D, plot: Plot): void {
  const { W, H } = plot;
  ctx.font = F_NUM;
  ctx.fillStyle = "#5b6574";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  for (const s of STRENGTH_TICKS) {
    const y = Math.round(plotY(plot, s)) + 0.5;
    ctx.strokeStyle = s === 0.2 ? "#f3c3a3" : "#eceff3";
    ctx.beginPath();
    ctx.moveTo(MARGIN.l, y);
    ctx.lineTo(W - MARGIN.r, y);
    ctx.stroke();
    ctx.fillText(s.toFixed(1), MARGIN.l - 6, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const a of AGE_TICKS) {
    if (Math.log10(a + 1) > plot.maxLog) continue;
    const x = Math.round(plotX(plot, a)) + 0.5;
    ctx.strokeStyle = "#f2f4f7";
    ctx.beginPath();
    ctx.moveTo(x, MARGIN.t);
    ctx.lineTo(x, H - MARGIN.b);
    ctx.stroke();
    ctx.fillText(a === 0 ? "new" : `${a}d`, x, H - MARGIN.b + 6);
  }
  ctx.fillStyle = "#3f4856";
  ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textBaseline = "alphabetic";
  ctx.save();
  ctx.translate(12, MARGIN.t + plotH(plot) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("strength", 0, 0);
  ctx.restore();
  ctx.textAlign = "right";
  ctx.fillText("age, log scale", W - MARGIN.r, H - 4);
  ctx.textAlign = "left";
}

function drawPoints(ctx: CanvasRenderingContext2D, plot: Plot, data: ScatterPoints, on: readonly boolean[]): void {
  const visible = data.points.filter((pt) => on[pt[2]]);
  const size = markerSize(visible.length);
  ctx.globalAlpha = 0.72;
  for (let layer = 0; layer < LAYER_COL.length; layer++) {
    if (!on[layer]) continue;
    ctx.fillStyle = LAYER_COL[layer];
    ctx.beginPath();
    for (const [age, s, l] of visible) if (l === layer) marker(ctx, layer, plotX(plot, age), plotY(plot, s), size);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#1e3a8a";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const [age, s, , band] of visible) {
    if (band !== 0) continue;
    const x = plotX(plot, age);
    const y = plotY(plot, s);
    ctx.moveTo(x + size * 0.5 + 2.5, y);
    ctx.arc(x, y, size * 0.5 + 2.5, 0, 7);
  }
  ctx.stroke();
}

function drawDensity(ctx: CanvasRenderingContext2D, plot: Plot, data: ScatterGrid, on: readonly boolean[]): void {
  const max = maxCell(data, on);
  const cw = plotW(plot) / GRID_COLS;
  const ch = plotH(plot) / GRID_ROWS;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const n = cellCount(data, on, col, row);
      if (n === 0) continue;
      const [r, g, b] = densityRgb(densityStep(n, max));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(MARGIN.l + col * cw, plotY(plot, (row + 1) / GRID_ROWS), Math.ceil(cw), Math.ceil(ch));
    }
  }
}

/** Draws axes plus points or density cells onto the base canvas. */
export function drawScatter(ctx: CanvasRenderingContext2D, scene: ScatterScene): void {
  const { plot, dpr, data, on } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, plot.W, plot.H);
  if (plot.W < 2 || plot.H < 2) return;
  drawAxes(ctx, plot);
  if (data.mode === "points") drawPoints(ctx, plot, data, on);
  else drawDensity(ctx, plot, data, on);
}

/** Inputs of the overlay draw: brush, the hovered or opened point, and the hovered density cell. */
export interface OverlayScene {
  plot: Plot;
  dpr: number;
  brush: Brush | null;
  /** The memory the drawer shows, as [age, strength], or null. */
  open: readonly [number, number] | null;
  hover: readonly [number, number] | null;
  cell: CellHit | null;
  selected: number;
}

/** Draws the brush, hover ring, open-memory ring and hovered cell onto the overlay canvas. */
export function drawOverlay(c: CanvasRenderingContext2D, o: OverlayScene): void {
  const { plot, dpr, brush } = o;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, plot.W, plot.H);
  if (plot.W < 2) return;
  if (brush) {
    const x0 = plotX(plot, brush.a0);
    const x1 = plotX(plot, brush.a1);
    const y0 = plotY(plot, brush.s0);
    const y1 = plotY(plot, brush.s1);
    c.fillStyle = "rgba(255,255,255,.62)";
    c.beginPath();
    c.rect(MARGIN.l, MARGIN.t, plotW(plot), plotH(plot));
    c.rect(x0, y1, x1 - x0, y0 - y1);
    c.fill("evenodd");
    c.fillStyle = "rgba(47,111,237,.06)";
    c.fillRect(x0, y1, x1 - x0, y0 - y1);
    c.strokeStyle = "#2f6fed";
    c.lineWidth = 1.5;
    c.strokeRect(x0, y1, x1 - x0, y0 - y1);
    c.font = F_NUM;
    c.fillStyle = "#1f55c9";
    c.textBaseline = "bottom";
    c.fillText(`${fmt(o.selected)} selected`, clamp(x0, MARGIN.l, plot.W - 90), Math.max(y1 - 3, 12));
  }
  if (o.cell && plot.maxLog > 0) {
    const cw = plotW(plot) / GRID_COLS;
    c.strokeStyle = "#111827";
    c.lineWidth = 1.5;
    c.strokeRect(MARGIN.l + o.cell.col * cw, plotY(plot, o.cell.s1), cw, plotY(plot, o.cell.s0) - plotY(plot, o.cell.s1));
  }
  for (const [pt, col, r] of [[o.hover, "#111827", 7], [o.open, "#2f6fed", 9]] as const) {
    if (!pt) continue;
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(plotX(plot, pt[0]), plotY(plot, pt[1]), r, 0, 7);
    c.stroke();
  }
}
