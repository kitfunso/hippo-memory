import type { ProjectSummary } from "../../../types";
import { clamp, fmt, fmtK, pct, plural } from "../format";
import { type Camera, tileScreen } from "./camera";
import { BAND_ORDER, BAND_RGB, BAND_TINT, riskColor } from "./riskColor";
import type { Tile } from "./squarify";
import { F_NAME, F_NUM, firstFit, tileName } from "./text";

/** Smallest on-screen cell, in px, at which a tile draws one cell per memory. */
export const DOT_MIN = 6;

/** Cached band-cell bitmap of one project tile. */
export interface CellBitmap {
  canvas: HTMLCanvasElement;
  cols: number;
  rows: number;
  n: number;
  version: number;
  sig: string;
}

/** Bitmaps by project key; owned by the Treemap component. */
export type BitmapCache = Map<string, CellBitmap>;

/** Everything one draw needs. Tile indices are positions in `tiles`. */
export interface Scene {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  dpr: number;
  tiles: readonly Tile[];
  projects: readonly ProjectSummary[];
  cam: Camera;
  hover: number;
  sel: number;
  /** Per-project search hits by key, or null when no search is active. */
  hits: ReadonlyMap<string, number> | null;
  bitmaps: BitmapCache;
  /** Bumps on every relayout so cached bitmaps know their tile moved. */
  version: number;
  hatch: CanvasPattern | null;
}

/** Hatched pattern for the open-conflict corner. */
export function makeHatch(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = c.height = 6;
  const x = c.getContext("2d");
  if (!x) return null;
  x.fillStyle = "#fff";
  x.fillRect(0, 0, 6, 6);
  x.strokeStyle = "#111827";
  x.lineWidth = 1.4;
  x.beginPath();
  x.moveTo(0, 6);
  x.lineTo(6, 0);
  x.moveTo(-1, 1);
  x.lineTo(1, -1);
  x.moveTo(5, 7);
  x.lineTo(7, 5);
  x.stroke();
  return ctx.createPattern(c, "repeat");
}

/** On-screen size in px of one memory cell in a tile showing `n` memories. */
export function cellSize(w: number, h: number, n: number): number {
  return n > 0 ? Math.sqrt(Math.max(0, (w - 4) * (h - 4)) / n) : 0;
}

/** Band index (BAND_ORDER) of the idx-th cell when cells run band by band; -1 past the end. */
export function bandAtCell(p: ProjectSummary, idx: number): number {
  let end = 0;
  for (let b = 0; b < BAND_ORDER.length; b++) {
    end += p.bands[BAND_ORDER[b]];
    if (idx < end) return b;
  }
  return -1;
}

const bandSig = (p: ProjectSummary) => BAND_ORDER.map((b) => p.bands[b]).join(",");

/** The cell bitmap for a tile: one pixel per memory, in band order. A cell stands for a band, never a specific memory. */
export function getBitmap(scene: Pick<Scene, "bitmaps" | "version">, tile: Tile, p: ProjectSummary): CellBitmap | null {
  const sig = bandSig(p);
  const cached = scene.bitmaps.get(tile.key);
  if (cached && cached.version === scene.version && cached.sig === sig) return cached;
  const n = p.live;
  const cols = Math.max(1, Math.round(Math.sqrt((n * tile.w) / Math.max(1, tile.h))));
  const rows = Math.ceil(n / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const x = canvas.getContext("2d");
  if (!x) return null;
  const img = x.createImageData(cols, rows);
  const d = img.data;
  let k = 0;
  for (let b = 0; b < BAND_ORDER.length; b++) {
    const rgb = BAND_RGB[b];
    const t = BAND_TINT[b];
    const count = p.bands[BAND_ORDER[b]];
    for (let c = 0; c < count && k < n; c++, k++) {
      const o = k * 4;
      d[o] = rgb[0] + (255 - rgb[0]) * t;
      d[o + 1] = rgb[1] + (255 - rgb[1]) * t;
      d[o + 2] = rgb[2] + (255 - rgb[2]) * t;
      d[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  const bm: CellBitmap = { canvas, cols, rows, n, version: scene.version, sig };
  scene.bitmaps.set(tile.key, bm);
  return bm;
}

/** What a pointer is over: a tile index and, when zoomed to cell level, a band index; -1 for none. */
export interface Hit {
  ti: number;
  band: number;
}

/** Hit test in canvas coordinates. */
export function hitTest(scene: Pick<Scene, "tiles" | "projects" | "cam" | "bitmaps">, mx: number, my: number): Hit {
  const { cam, tiles } = scene;
  const wx = (mx - cam.x) / cam.k;
  const wy = (my - cam.y) / cam.k;
  for (let ti = 0; ti < tiles.length; ti++) {
    const t = tiles[ti];
    if (wx < t.x || wx >= t.x + t.w || wy < t.y || wy >= t.y + t.h) continue;
    const p = scene.projects[t.index];
    const s = tileScreen(t, cam);
    const bm = scene.bitmaps.get(t.key);
    let band = -1;
    if (bm && cellSize(s.w, s.h, p.live) >= DOT_MIN) {
      const c = Math.floor((mx - s.x - 2) / ((s.w - 4) / bm.cols));
      const r = Math.floor((my - s.y - 2) / ((s.h - 4) / bm.rows));
      const idx = r * bm.cols + c;
      if (c >= 0 && c < bm.cols && r >= 0 && idx < bm.n) band = bandAtCell(p, idx);
    }
    return { ti, band };
  }
  return { ti: -1, band: -1 };
}

function drawCells(scene: Scene, tile: Tile, p: ProjectSummary, x: number, y: number, w: number, h: number, alpha: number): boolean {
  const { ctx, W, H } = scene;
  const cell = cellSize(w, h, p.live);
  if (cell < DOT_MIN || w <= 8 || h <= 8) return false;
  const bm = getBitmap(scene, tile, p);
  if (!bm) return false;
  const ix = x + 2;
  const iy = y + 2;
  const iw = w - 4;
  const ih = h - 4;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = alpha * Math.min(1, (cell - DOT_MIN) / 3 + 0.35);
  ctx.fillStyle = "#fff";
  ctx.fillRect(ix, iy, iw, ih);
  ctx.drawImage(bm.canvas, ix, iy, iw, ih);
  const cw = iw / bm.cols;
  const ch = ih / bm.rows;
  if (cw >= DOT_MIN - 1 && ch >= DOT_MIN - 1) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = cw >= 14 ? 2 : 1;
    ctx.beginPath();
    const c0 = Math.max(0, Math.floor(-ix / cw));
    const c1 = Math.min(bm.cols, Math.ceil((W - ix) / cw));
    const r0 = Math.max(0, Math.floor(-iy / ch));
    const r1 = Math.min(bm.rows, Math.ceil((H - iy) / ch));
    for (let c = c0; c <= c1; c++) {
      const gx = ix + c * cw;
      ctx.moveTo(gx, Math.max(iy, 0));
      ctx.lineTo(gx, Math.min(iy + ih, H));
    }
    for (let r = r0; r <= r1; r++) {
      const gy = iy + r * ch;
      ctx.moveTo(Math.max(ix, 0), gy);
      ctx.lineTo(Math.min(ix + iw, W), gy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
  return true;
}

function drawConflictCorner(scene: Scene, p: ProjectSummary, x: number, y: number, w: number, h: number): void {
  const { ctx, hatch } = scene;
  const c = Math.min(clamp(6 + 4 * Math.sqrt(p.openConflicts), 8, 26), Math.min(w, h) * 0.38);
  ctx.fillStyle = hatch ?? "#e8590c";
  ctx.beginPath();
  ctx.moveTo(x + w - c, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + c);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.stroke();
}

function drawLabel(scene: Scene, p: ProjectSummary, x: number, y: number, w: number, h: number, showCells: boolean, hit: number | undefined): void {
  const { ctx, W } = scene;
  const lx = Math.max(x, 0) + 8;
  const maxW = Math.min(x + w, W) - lx - (p.openConflicts ? 26 : 8);
  const top = Math.max(y, 0);
  const name = maxW > 30 ? tileName(ctx, p.name, maxW) : "";
  if (!name) return;
  const lines: [string, string][] = [[F_NAME, name]];
  const stat =
    h >= 44 && firstFit(ctx, F_NUM, maxW, [`${fmt(p.live)} · ${pct(p.share, 0)} at risk`, `${fmt(p.live)} · ${pct(p.share, 0)}`, fmtK(p.live)]);
  if (stat) lines.push([F_NUM, stat]);
  const conflicts = stat && h >= 60 && p.openConflicts > 0 && firstFit(ctx, F_NUM, maxW, [plural(p.openConflicts, "conflict"), `${p.openConflicts} cf`]);
  if (conflicts) lines.push([F_NUM, conflicts]);
  const matches = stat && hit && h >= 76 && firstFit(ctx, F_NUM, maxW, [plural(hit, "match", "matches")]);
  if (matches) lines.push([F_NUM, matches]);
  if (showCells) {
    let mw = 0;
    for (const [f, s] of lines) {
      ctx.font = f;
      mw = Math.max(mw, ctx.measureText(s).width);
    }
    ctx.fillStyle = "rgba(255,255,255,.93)";
    ctx.fillRect(lx - 5, top + 3, mw + 10, lines.length * 16 + 6);
  }
  ctx.textBaseline = "alphabetic";
  lines.forEach(([f, s], li) => {
    ctx.font = f;
    ctx.fillStyle = showCells ? (li ? "#3f4856" : "#111827") : riskColor(p.share).ink;
    ctx.fillText(s, lx, top + 18 + li * 16);
  });
}

/** Paints the whole treemap: tiles, cells when zoomed, conflict corners, labels, hover and selection outlines. */
export function drawTreemap(scene: Scene): void {
  const { ctx, W, H, dpr, tiles, projects, cam, hits } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  if (tiles.length === 0) return;
  const { k, x: ox, y: oy } = cam;
  if (scene.hatch && "DOMMatrix" in globalThis) scene.hatch.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
  for (const t of tiles) {
    const p = projects[t.index];
    const x = t.x * k + ox;
    const y = t.y * k + oy;
    const w = t.w * k;
    const h = t.h * k;
    if (x > W || y > H || x + w < 0 || y + h < 0 || w < 0.3 || h < 0.3) continue;
    const hit = hits ? hits.get(t.key) ?? 0 : undefined;
    const alpha = hits && hit === 0 ? 0.28 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = riskColor(p.share).css;
    ctx.fillRect(x, y, w, h);
    const showCells = drawCells(scene, t, p, x, y, w, h, alpha);
    if (p.openConflicts > 0) drawConflictCorner(scene, p, x, y, w, h);
    if (w >= 58 && h >= 26) drawLabel(scene, p, x, y, w, h, showCells, hit);
  }
  ctx.globalAlpha = 1;
  const outline = (ti: number, color: string, lw: number) => {
    if (ti < 0 || ti >= tiles.length) return;
    const s = tileScreen(tiles[ti], cam);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeRect(s.x + lw / 2, s.y + lw / 2, s.w - lw, s.h - lw);
  };
  if (scene.hover >= 0 && scene.hover !== scene.sel) outline(scene.hover, "#111827", 2);
  if (scene.sel >= 0) {
    outline(scene.sel, "#ffffff", 5);
    outline(scene.sel, "#2f6fed", 3);
  }
}
