// Builds the card-cabinet hero figure: src/components/CardCabinet.astro, plus a preview page with --preview=<dir>.
// Run: node website/scripts/figure/build-cabinet.mjs [--audit] [--preview=<dir>]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./iso-kit.mjs";
import * as G from "./lathe.mjs";
import * as A from "./audit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(HERE, "..", "..", "src", "components", "CardCabinet.astro");
const PREVIEW = (process.argv.find((arg) => arg.startsWith("--preview=")) ?? "").slice(10);

// Strength model, one to one with src/base/memory/strength.ts:31-46 and 141-179, entry.ts:150 and 436-451,
// and consolidate/merge.ts:28 and 291-296. `every` (a session each 30 days) is the scenario, not code.
const MODEL = { half: 365, base: 0.5, boost: 0.1, gain: 2, merged: 0.3, every: 30, file: 0.3, sleep: 0.7, days: 1460 };
const STILL_DAY = 365;

function strengthOf(kind, age, d, M) {
  const decay = (days, half) => Math.pow(M.base, Math.max(0, days) / half);
  if (kind === "recalled") {
    const n = Math.floor(d / M.every);
    if (n === 0) return decay(d + age, M.half);
    return Math.min(1, decay(d - n * M.every, M.half + M.gain * n) * (1 + M.boost * Math.log2(n + 1)));
  }
  if (kind === "merged") return decay(d - M.sleep, M.half);
  if (kind === "source" && d >= M.sleep) return decay(d + age, Math.max(1, Math.floor(M.half * M.merged)));
  return decay(d + age, M.half);
}

function readoutOf(d, M, strength) {
  if (d < M.file) return "day 0 · new card in the buffer";
  const f = (kind) => strength(kind, 0, d, M).toFixed(2);
  return `day ${Math.floor(d + 1e-6)} · ${d < M.every ? "filed" : "recalled"} ${f("recalled")} · unused ${f("unused")}`;
}

// The pointer blade turns in the dial's plane, so one affine matrix moves it; knurl ribs are rebuilt.
function dialPose(t, D) {
  const shift = (v) => [v[0] * D.ex[0] + v[1] * D.ey[0] + v[2] * D.ez[0], v[0] * D.ex[1] + v[1] * D.ey[1] + v[2] * D.ez[1]];
  const at = (p) => { const s = shift(p); return [D.o[0] + s[0], D.o[1] + s[1]]; };
  const c = D.dial.c;
  const kn = D.dial.knurl;
  const o = at([c[0] + 3, c[1], c[2]]);
  const p = shift([0, -1, 0]);
  const q = shift([0, 0, 1]);
  const det = p[0] * q[1] - q[0] * p[1];
  const cs = Math.cos(t);
  const sn = Math.sin(t);
  const er = [[p[0] * cs - q[0] * sn, p[0] * sn + q[0] * cs], [p[1] * cs - q[1] * sn, p[1] * sn + q[1] * cs]];
  const inv = [[q[1] / det, -q[0] / det], [-p[1] / det, p[0] / det]];
  const m = [0, 1].map((r) => [er[r][0] * inv[0][0] + er[r][1] * inv[1][0], er[r][0] * inv[0][1] + er[r][1] * inv[1][1]]);
  const e = o[0] - (m[0][0] * o[0] + m[0][1] * o[1]);
  const f = o[1] - (m[1][0] * o[0] + m[1][1] * o[1]);
  const blade = `matrix(${m[0][0].toFixed(4)} ${m[1][0].toFixed(4)} ${m[0][1].toFixed(4)} ${m[1][1].toFixed(4)} ${e.toFixed(2)} ${f.toFixed(2)})`;
  const ribs = [];
  for (let i = 0; i < kn.count; i++) {
    const a = t + (i / kn.count) * Math.PI * 2;
    const ny = -Math.sin(a);
    const nz = Math.cos(a);
    const x = Math.min(1, Math.max(0, (ny * D.view[1] + nz * D.view[2] - 0.1) / 0.45));
    const alpha = x * x * (3 - 2 * x);
    const a0 = at([c[0] + kn.s0, c[1] + ny * kn.r, c[2] + nz * kn.r]);
    const a1 = at([c[0] + kn.s1, c[1] + ny * kn.r, c[2] + nz * kn.r]);
    ribs.push(alpha < 0.03 ? { d: "", alpha: "0" } : { d: `M${a0[0].toFixed(1)} ${a0[1].toFixed(1)}L${a1[0].toFixed(1)} ${a1[1].toFixed(1)}`, alpha: alpha.toFixed(2) });
  }
  return { blade, ribs };
}

// World: x across, y toward the front, z up; about 1 unit per px.
const W = 600;
const H = 450;
const CASE = { x: -66, y: -34, w: 132, d: 68, r: 1.2 };
const FRONT = CASE.y + CASE.d;
const CASE_Z = [18, 110];
const TOP = { x: -68.5, y: -36.5, w: 137, d: 73, r: 2.4 };
const TOP_Z = [110, 114.5];
const PLINTH = { x: -67.5, y: -35.5, w: 135, d: 71, r: 1.6 };
const CAP = { x: -69, y: -37, w: 138, d: 74, r: 2.2 };
const COLS = [-61.5, -19, 23.5];
const ROWS = [80.75, 51.5, 22.25];
const DW = 38;
const DH = 25;
const FD = 1.6;
const CW = 30;
const CH = 18;
const TH = 3.6;
const TW = 8.5;
const TABS = [1.6, 10.75, 19.9];
const EPI = { col: 0, row: 1, pull: 30, from: 36, step: 2.4, count: 12, slot: 5, inner: [33.6, 31.2, 28.8] };
const SEM = { col: 2, row: 2, pull: 20, from: 36, step: 2.4, count: 7, slot: 4, inner: [33.6, 31.2] };
const TRAY = { x: -61.5, y: 4, w: 38, d: 17, r: 1.2 };
const TRAY_Z = [114.5, 116, 123];
const HOLD = { x: 2, y: 8, w: 40, d: 14, r: 1.6 };
const HOLD_Z = [114.5, 117.5];
const LIP_TOP = 122;
const DIAL_C = [66, 0, 64];
const DIAL_R = 19;
const Z_AIR = 128;
const cardX = (col) => COLS[col] + DW / 2;
const floorTop = (row) => ROWS[row] + 2.5;
const TRAY_C = [cardX(0), 12.5, TRAY_Z[1]];
const DRAWER_C = [cardX(EPI.col), FRONT + 2 + EPI.step * EPI.slot, floorTop(EPI.row)];
const HOLDER_C = [22, 14.6, HOLD_Z[1]];

const P = k.fitProjection(
  [
    ...k.boxCorners(CAP, 0, 18),
    ...k.boxCorners(TOP, 110, 114.5),
    [COLS[EPI.col], FRONT + EPI.pull + FD + 3, ROWS[EPI.row]],
    [COLS[SEM.col], FRONT + SEM.pull + FD + 3, ROWS[SEM.row]],
    [TRAY_C[0] - CW / 2, TRAY_C[1], Z_AIR + CH + TH],
    [HOLDER_C[0] + CW / 2, HOLDER_C[1], Z_AIR + CH + TH],
    [DIAL_C[0] + 9.5, DIAL_C[1] - DIAL_R, DIAL_C[2] - DIAL_R],
  ],
  W,
  H,
  { pad: 14, azimuth: 50, elevation: 31 },
);
const V = G.viewOf(P);
const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const path3 = (points, closed = false) => k.pathOf(points.map(at), closed);
const R = A.recorder(P);
const put = (name, centre, svg, shapes, extra = {}) => R.put({ name, at: centre, svg, shapes: shapes.map(R.solid), ...extra });
const slab = (plan, z, h, name, meta = {}) => A.slab(plan, z, h, { name, ...meta });
const FRAME_Y = (y) => G.frameOf([0, y, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1]);

// Plinth on four turned feet, the case, the top board.
function base() {
  const corners = k.corners(PLINTH, 9).sort((a, b) => k.depthOf([...a, 0], P) - k.depthOf([...b, 0], P));
  corners.forEach(([x, y], index) => {
    const svg = S(k.cylinder(x, y, 4.2, 0, 6.5, P, 24), { tone: "mid", inner: L(k.sideArc(x, y, 4.2, 2.4, P, 16), { tone: "faint" }) }) + S(k.cylinder(x, y, 5.6, 6.5, 2.5, P, 28), { tone: "lo" });
    put(`stand.foot${index}`, [x, y, 4], svg, [A.cylinder(x, y, 4.2, 0, 6.5, { name: `stand.foot${index}` }), A.cylinder(x, y, 5.6, 6.5, 2.5, { name: `stand.flange${index}` })]);
  });
  const plinth = S(k.slabOf(PLINTH, 9, 7.5, P, 6, 0.8), { tone: "lo", inner: L(k.sideSeam(PLINTH, 12.6, P, 6), { tone: "faint" }) });
  const plate = { x: -14, y: PLINTH.y + PLINTH.d, w: 28, d: 0.6, r: 0.2 };
  const plateSvg = S(k.slabOf(plate, 10.6, 4.4, P, 2, 0.3), { tone: "mid" }) + L(path3([[plate.x + 3, plate.y + 0.6, 13.6], [plate.x + 19, plate.y + 0.6, 13.6]]) + path3([[plate.x + 3, plate.y + 0.6, 12], [plate.x + 13, plate.y + 0.6, 12]]), { tone: "lo", free: true }) + D([at([plate.x + 1.4, plate.y + 0.6, 12.8]), at([plate.x + plate.w - 1.4, plate.y + 0.6, 12.8])], { size: 0.45 });
  put("stand.plinth", [0, 0, 12], `<path class="iso-halo" d="${k.haloOf(CAP, 0, 18, P)}"/>` + plinth + plateSvg, [slab(PLINTH, 9, 7.5, "stand.plinth"), A.box([plate.x, plate.y, 10.6], [plate.x + plate.w, plate.y + 0.6, 15], { name: "stand.label" })]);
  put("stand.cap", [0, 0, 17], S(k.slabOf(CAP, 16.5, 1.5, P, 6, 0.6), { tone: "mid" }), [slab(CAP, 16.5, 1.5, "stand.cap")]);

  const sidePanel = path3([[66, -27, 26], [66, 27, 26], [66, 27, 102], [66, -27, 102]], true);
  const stile = path3([[66, FRONT - 2.2, CASE_Z[0]], [66, FRONT - 2.2, CASE_Z[1]]]);
  const caseSvg = S(k.slabOf(CASE, CASE_Z[0], CASE_Z[1] - CASE_Z[0], P, 3), { tone: "mid" }) + L(sidePanel, { tone: "faint" }) + L(stile, { tone: "faint" });
  put("case", [0, 0, 64], caseSvg, [slab(CASE, CASE_Z[0], CASE_Z[1] - CASE_Z[0], "case")]);

  const topSvg = S(k.slabOf(TOP, TOP_Z[0], TOP_Z[1] - TOP_Z[0], P, 6, 1), { tone: "mid", inner: L(k.sideSeam(TOP, 112, P, 6), { tone: "faint" }) });
  const screws = [[-63, -31], [63, -31], [63, 31], [-63, 31]];
  const screwSvg = L(screws.map(([x, y]) => k.ring(x, y, 1.6, TOP_Z[1], P, 14)).join(""), { tone: "lo" }) + D(screws.map(([x, y]) => at([x, y, TOP_Z[1]])), { size: 0.45 });
  const groove = L(k.planOutline(k.insetPlan(TOP, 4.5), TOP_Z[1], P, 6), { tone: "faint" });
  put("top", [0, 0, 112], topSvg + groove + screwSvg, [slab(TOP, TOP_Z[0], TOP_Z[1] - TOP_Z[0], "top")]);
}

// A drawer front with its brass label holder, cup pull and rod knob, at front face `y`.
function front(col, row, y, name) {
  const x = COLS[col];
  const z = ROWS[row];
  const cx = x + DW / 2;
  const plan = { x, y, w: DW, d: FD, r: 0.5 };
  const face = y + FD;
  const holder = { x: cx - 7, y: face, w: 14, d: 0.6, r: 0.3 };
  const hz = z + 16.2;
  const label = [[cx - 5.6, face + 0.6, hz + 1.2], [cx + 5.6, face + 0.6, hz + 1.2], [cx + 5.6, face + 0.6, hz + 5.3], [cx - 5.6, face + 0.6, hz + 5.3]];
  const pullF = G.frameOf([cx, face, z + 10], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  const cup = Array.from({ length: 13 }, (_, i) => [5.2 * Math.cos((i / 12) * Math.PI), 5.2 * Math.sin((i / 12) * Math.PI)]);
  const knobF = G.frameAlong([cx, face, z + 4], [0, 1, 0]);
  const knob = [[0, 1.25], [0.9, 1.25], [0.9, 1.9], [2.5, 1.9]];
  const svg = [
    S(k.slabOf(plan, z, DH, P, 3, 0.4), { tone: "mid" }),
    S(k.slabOf(holder, hz, 6.5, P, 2, 0.25), { tone: "mid" }),
    `<path class="cab-label" d="${path3(label, true)}"/>`,
    L(path3([[cx - 4, face + 0.6, hz + 3.6], [cx + 2.5, face + 0.6, hz + 3.6]]), { tone: "lo", free: true }),
    D([at([cx - 6.3, face + 0.6, hz + 3.25]), at([cx + 6.3, face + 0.6, hz + 3.25])], { size: 0.4 }),
    S(G.prismOf(pullF, cup, 0, 2.6, P), { tone: "mid" }),
    D([at([cx - 6.6, face, z + 11.2]), at([cx + 6.6, face, z + 11.2])], { size: 0.45 }),
    S(G.solidOf(knob, knobF, P, { steps: 24 }), { tone: "mid" }),
  ].join("");
  const shapes = [
    slab(plan, z, DH, `${name}.front`),
    slab(holder, hz, 6.5, `${name}.holder`),
    A.prism(pullF, cup, 0, 2.6, { name: `${name}.pull` }),
    A.solid(knobF, knob, { name: `${name}.knob` }),
  ];
  put(name, [cx, y + 1, z + DH / 2], svg, shapes);
}

// One index card in the plane y, standing on z = b, with its ink drawn on the face.
const outlineOf = (cx, b, tab) => {
  const x0 = cx - CW / 2;
  const z1 = b + CH;
  const t0 = x0 + tab;
  return [[x0, b], [x0 + CW, b], [x0 + CW, z1], [t0 + TW + 0.9, z1], [t0 + TW, z1 + TH], [t0, z1 + TH], [t0 - 0.9, z1], [x0, z1]];
};
function inkOf(cx, y, b, tab, lines) {
  const x0 = cx - CW / 2;
  const t0 = x0 + tab;
  const rows = [[[t0 + 1.4, b + CH + 1.9], [t0 + TW - 1.6, b + CH + 1.9]]];
  const widths = lines === "full" ? [24, 19, 25, 13] : [20];
  widths.forEach((w, i) => rows.push([[x0 + 2.4, b + CH - (lines === "full" ? 2.4 : 0.9) - i * 2.6], [x0 + 2.4 + w, b + CH - (lines === "full" ? 2.4 : 0.9) - i * 2.6]]));
  return rows.map(([[xa, za], [xb, zb]]) => path3([[xa, y, za], [xb, y, zb]])).join("");
}
function cardSvg(card, d) {
  const { cx, y, b, tab, kind, age, lit } = card;
  const face = y + 0.3;
  const ink = kind === "recalled" ? 1 : strengthOf(kind, age, d, MODEL);
  const opacity = ink.toFixed(3);
  return `<path class="cab-card"${lit ? " data-lit" : ""} d="${path3(outlineOf(cx, b, tab).map(([x, z]) => [x, face, z]), true)}"/><g class="cab-ink" data-ink="${kind}" data-age="${age}" opacity="${opacity}"><path data-free="" d="${inkOf(cx, face, b, tab, lit ? "full" : "short")}"/></g>`;
}
const cardShape = (card, rise = 0, name) => A.prism(FRAME_Y(card.y), outlineOf(card.cx, card.b, card.tab).map(([x, z], i) => [x, z + (i >= 2 && rise ? rise : 0)]), 0, 0.3, { name });

// A drawer pulled out: floor, walls and cards outside the case, and what shows through the opening.
const AGES = { 0: [30, 140, 40, 210, 95, 0, 0, 260, 75, 180, 15, 320], 2: [400, 150, 520, 260, 0, 90, 330] };
const SOURCES = [2, 8];
function pulled(spec, name, cards) {
  const x = COLS[spec.col];
  const z = ROWS[spec.row];
  const cx = x + DW / 2;
  const back = FRONT;
  const panel = FRONT + spec.pull;
  const floor = { x: x + 3.2, y: back, w: DW - 6.4, d: spec.pull, r: 0.2 };
  const left = { x: x + 2, y: back, w: 1.2, d: spec.pull, r: 0.2 };
  const right = { x: x + DW - 3.2, y: back, w: 1.2, d: spec.pull, r: 0.2 };
  put(`${name}.floor`, [cx, back + spec.pull / 2, z + 2], S(k.slabOf(floor, z + 1.5, 1, P, 2), { tone: "lo" }), [slab(floor, z + 1.5, 1, `${name}.floor`)]);
  put(`${name}.left`, [x + 2.6, back + spec.pull / 2, z + 8], S(k.slabOf(left, z + 1.5, 14, P, 2, 0.3), { tone: "mid" }), [slab(left, z + 1.5, 14, `${name}.left`)]);
  put(`${name}.right`, [x + DW - 2.6, back + spec.pull / 2, z + 8], S(k.slabOf(right, z + 1.5, 14, P, 2, 0.3), { tone: "mid" }), [slab(right, z + 1.5, 14, `${name}.right`)]);
  front(spec.col, spec.row, panel, `${name}.front`);
  const ages = AGES[spec.col];
  for (let i = 0; i < spec.count; i++) {
    const card = { cx, y: FRONT + 2 + spec.step * i, b: z + 2.5, tab: TABS[i % 3], age: ages[i], kind: "unused" };
    if (i === spec.slot) {
      cards.push({ ...card, slot: name });
      continue;
    }
    const source = spec === EPI && SOURCES.includes(i);
    if (source) card.kind = "source";
    const svg = cardSvg(card, STILL_DAY);
    const tag = source ? ` data-cab="src"` : "";
    put(`${name}.card${i}`, [cx, card.y, card.b + 10], `<g${tag}>${svg}</g>`, [cardShape(card, source ? 3.5 : 0, `${name}.card${i}`)]);
  }
  return { cx, z, panel };
}

// The open slot in the case front behind a pulled drawer; drawn clipped to the opening, after the case.
function opening(spec, id) {
  const x = COLS[spec.col];
  const z = ROWS[spec.row];
  const cx = x + DW / 2;
  const hole = [[x + 2, FRONT, z + 1.5], [x + DW - 2, FRONT, z + 1.5], [x + DW - 2, FRONT, z + 23.5], [x + 2, FRONT, z + 23.5]];
  const deep = FRONT - 30;
  const parts = [`<path class="cab-void" d="${path3(hole, true)}"/>`];
  const floor = { x: x + 3.2, y: deep, w: DW - 6.4, d: FRONT - deep, r: 0.2 };
  parts.push(S(k.slabOf(floor, z + 1.5, 1, P, 2), { tone: "lo" }));
  parts.push(S(k.slabOf({ x: x + 2, y: deep, w: 1.2, d: FRONT - deep, r: 0.2 }, z + 1.5, 14, P, 2), { tone: "mid" }));
  const ages = AGES[spec.col];
  spec.inner.slice().reverse().forEach((y, i) => {
    const card = { cx, y, b: z + 2.5, tab: TABS[(i + 1) % 3], age: ages[(i * 5 + 3) % ages.length] + 20, kind: "unused" };
    parts.push(cardSvg(card, STILL_DAY));
  });
  parts.push(S(k.slabOf({ x: x + DW - 3.2, y: deep, w: 1.2, d: FRONT - deep, r: 0.2 }, z + 1.5, 14, P, 2), { tone: "mid" }));
  return { clip: `<clipPath id="${id}"><path d="${path3(hole, true)}"/></clipPath>`, svg: `<g class="cab-cave" clip-path="url(#${id})">${parts.join("")}</g>` };
}

// The buffer tray and the recall holder on the top board.
function tray() {
  const [z0, z1, z2] = TRAY_Z;
  const { x, y, w, d } = TRAY;
  const walls = {
    back: { x, y, w, d: 1.2, r: 0.3 },
    left: { x, y: y + 1.2, w: 1.2, d: d - 2.4, r: 0.3 },
    right: { x: x + w - 1.2, y: y + 1.2, w: 1.2, d: d - 2.4, r: 0.3 },
    front: { x, y: y + d - 1.2, w, d: 1.2, r: 0.3 },
  };
  put("tray.floor", [x + w / 2, y + d / 2, z0 + 0.7], S(k.slabOf(TRAY, z0, z1 - z0, P, 4, 0.4), { tone: "lo" }), [slab(TRAY, z0, z1 - z0, "tray.floor")]);
  for (const [side, plan] of Object.entries(walls)) {
    const centre = [plan.x + plan.w / 2, plan.y + plan.d / 2, (z1 + z2) / 2];
    const tag = { x: x + w / 2 - 6, y: y + d, w: 12, d: 0.5, r: 0.2 };
    const label = [[tag.x + 1, y + d + 0.5, z1 + 1.6], [tag.x + 11, y + d + 0.5, z1 + 1.6], [tag.x + 11, y + d + 0.5, z1 + 5.4], [tag.x + 1, y + d + 0.5, z1 + 5.4]];
    const tagSvg = S(k.slabOf(tag, z1 + 0.8, 5.4, P, 2, 0.2), { tone: "mid" }) + `<path class="cab-label" d="${path3(label, true)}"/>` + L(path3([[tag.x + 2.6, y + d + 0.5, z1 + 3.5], [tag.x + 7.4, y + d + 0.5, z1 + 3.5]]), { tone: "lo", free: true });
    const rivets = side === "front" ? tagSvg + D([at([x + 3, y + d, z2 - 1.6]), at([x + w - 3, y + d, z2 - 1.6])], { size: 0.42 }) : "";
    const extra = side === "front" ? [A.box([tag.x, tag.y, z1 + 0.8], [tag.x + tag.w, tag.y + 0.5, z1 + 6.2], { name: "tray.tag" })] : [];
    put(`tray.${side}`, centre, S(k.slabOf(plan, z1, z2 - z1, P, 2, 0.3), { tone: "mid" }) + rivets, [slab(plan, z1, z2 - z1, `tray.${side}`), ...extra]);
  }
}
function holder() {
  const [z0, z1] = HOLD_Z;
  const back = { x: 4, y: 12.2, w: 36, d: 1.4, r: 0.4 };
  const lip = { x: 4, y: 16.2, w: 36, d: 1.2, r: 0.4 };
  const cheeks = [{ x: 2.6, y: 12.2, w: 1.4, d: 5.2, r: 0.3 }, { x: 40, y: 12.2, w: 1.4, d: 5.2, r: 0.3 }];
  const screws = [[4.6, 9.8], [39.4, 9.8], [4.6, 20.2], [39.4, 20.2]];
  const baseSvg = S(k.slabOf(HOLD, z0, z1 - z0, P, 5, 0.6), { tone: "mid" }) + D(screws.map(([sx, sy]) => at([sx, sy, z1])), { size: 0.42 });
  put("holder.base", [22, 15, z0 + 1.5], baseSvg, [slab(HOLD, z0, z1 - z0, "holder.base")]);
  put("holder.back", [22, 12.9, 125], S(k.slabOf(back, z1, 15.5, P, 2, 0.4), { tone: "mid", inner: L(k.sideSeam(back, 130.5, P, 2), { tone: "faint" }) }), [slab(back, z1, 15.5, "holder.back")]);
  put("holder.lip", [22, 16.8, 119.7], S(k.slabOf(lip, z1, LIP_TOP - z1, P, 2, 0.3), { tone: "mid" }) + D([at([8, lip.y + lip.d, 120]), at([36, lip.y + lip.d, 120])], { size: 0.42 }), [slab(lip, z1, LIP_TOP - z1, "holder.lip")]);
  cheeks.forEach((plan, i) => put(`holder.cheek${i}`, [plan.x + 0.7, 14.8, 121.5], S(k.slabOf(plan, z1, 8.5, P, 2, 0.3), { tone: "mid" }), [slab(plan, z1, 8.5, `holder.cheek${i}`)]));
}

// The day dial on the side: mount plate, dial with a four-year scale, pointer blade and knurled knob.
const DIAL_F = G.frameOf(DIAL_C, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
const onDial = (s, r, theta) => [DIAL_C[0] + s, DIAL_C[1] - r * Math.sin(theta), DIAL_C[2] + r * Math.cos(theta)];
const thetaOf = (day) => (day / MODEL.days) * Math.PI * 2;
const KNURL = { s0: 2.6, s1: 8, r: 5, count: 28 };
const CAM = { o: at([0, 0, 0]), ex: k.axisVector(P, [1, 0, 0]), ey: k.axisVector(P, [0, 1, 0]), ez: k.axisVector(P, [0, 0, 1]), view: V, dial: { c: DIAL_C, knurl: KNURL } };
function dial() {
  const plate = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2 + Math.PI / 24;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.3);
    return [23 * sq(c), 23 * sq(s)];
  });
  const plateF = G.frameOf([DIAL_C[0], DIAL_C[1], DIAL_C[2]], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const ticks = { minor: [], major: [] };
  for (let i = 0; i < 48; i++) {
    const theta = (i / 48) * Math.PI * 2;
    const major = i % 12 === 0;
    (major ? ticks.major : ticks.minor).push(path3([onDial(2.6, 14.9, theta), onDial(2.6, major ? 11.2 : 13.1, theta)]));
  }
  const screws = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => at([DIAL_C[0] + 0.8, DIAL_C[1] + 19.6 * a, DIAL_C[2] + 19.6 * b]));
  const blade = [[-1.7, 3.6], [1.7, 3.6], [0.45, 15.2], [-0.45, 15.2]];
  const pose = dialPose(thetaOf(STILL_DAY), CAM);
  const bladeSvg = `<g data-cab="blade" transform="${pose.blade}"><path class="cab-blade" d="${path3(blade.map(([p, q]) => [DIAL_C[0] + 3, DIAL_C[1] - p, DIAL_C[2] + q]), true)}"/></g>`;
  const ribs = pose.ribs.map((rib) => `<path data-cab="rib" d="${rib.d}" stroke-opacity="${rib.alpha}"/>`).join("");
  const svg = [
    S(G.prismOf(plateF, plate, 0, 0.8, P), { tone: "mid" }),
    D(screws, { size: 0.45 }),
    S(G.disc(0.8, 2.6, DIAL_R, DIAL_F, P), { tone: "mid" }),
    S(G.ringBand(2.6, 3.6, 16.6, DIAL_R, DIAL_F, P, { hole: [3.6, 16.6] }), { tone: "mid" }),
    L(path3(Array.from({ length: 97 }, (_, i) => onDial(2.6, 14.9, (i / 96) * Math.PI * 2)), true), { tone: "lo" }),
    L(ticks.minor.join(""), { tone: "lo", free: "end" }),
    L(ticks.major.slice(1).join(""), { tone: "mid", free: "end" }),
    L(ticks.major[0], { tone: "hi", free: "end" }),
    bladeSvg,
    S(G.disc(KNURL.s0, KNURL.s1, KNURL.r, DIAL_F, P), { tone: "mid", inner: `<g class="cab-ribs">${ribs}</g>` }),
    S(G.disc(KNURL.s1, KNURL.s1 + 0.8, 3.6, DIAL_F, P), { tone: "mid" }),
    D([at([DIAL_C[0] + KNURL.s1 + 0.8, DIAL_C[1], DIAL_C[2]])], { size: 0.5, tone: "hi" }),
  ].join("");
  put("dial", [DIAL_C[0] + 3, DIAL_C[1], DIAL_C[2]], svg, [
    A.prism(plateF, plate, 0, 0.8, { name: "dial.plate" }),
    A.disc(DIAL_F, 0.8, 2.6, DIAL_R, { name: "dial.face" }),
    A.ring(DIAL_F, 2.6, 3.6, 16.6, DIAL_R, { name: "dial.bezel" }),
    A.disc(DIAL_F, KNURL.s0, KNURL.s1 + 0.8, KNURL.r, { name: "dial.knob" }),
  ]);
}

// The watched card: drawn once at its tray position, moved by the live script between slot groups.
const WATCHED = { cx: TRAY_C[0], y: TRAY_C[1], b: TRAY_C[2], tab: TABS[2], kind: "recalled", age: 0, lit: true };
const NEW_SEM = { kind: "merged", age: 0 };
const SLOT_TOP = { tray: TRAY_Z[2] + 1.5, drawer: ROWS[EPI.row] + DH + 1.5, holder: LIP_TOP + 1.5 };
function slots(cards) {
  const moved = (centre, name, rest, top) => {
    const card = { ...WATCHED, cx: centre[0], y: centre[1], b: centre[2] };
    put(`slot.${name}`, [centre[0], centre[1], centre[2] + 10], `<g data-slot="${name}">${rest}</g>`, [cardShape(card, top - centre[2], `slot.${name}`)]);
  };
  const offset = G.sub3(HOLDER_C, TRAY_C);
  const still = `<g data-cab="card" transform="${k.translateAlong(P, offset)}">${cardSvg(WATCHED, STILL_DAY)}</g>`;
  moved(TRAY_C, "tray", "", SLOT_TOP.tray);
  moved(DRAWER_C, "drawer", "", SLOT_TOP.drawer);
  moved(HOLDER_C, "holder", still, SLOT_TOP.holder);
  const sem = cards.find((card) => card.slot === "semantic");
  const card = { ...sem, ...NEW_SEM };
  put("semantic.new", [card.cx, card.y, card.b + 10], `<g data-cab="sem" style="opacity:1">${cardSvg(card, STILL_DAY)}</g>`, [cardShape(card, 22, "semantic.new")]);
}

// Build every item, settle the painter's order from true depth, then audit.
base();
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    if ((col === EPI.col && row === EPI.row) || (col === SEM.col && row === SEM.row)) continue;
    front(col, row, FRONT, `drawer.${col}${row}`);
  }
}
const cards = [];
pulled(EPI, "episodic", cards);
pulled(SEM, "semantic", cards);
tray();
holder();
dial();
slots(cards);
A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
const caseKey = R.items.find((item) => item.name === "case").key;
const holes = [opening(EPI, "cab-open-e"), opening(SEM, "cab-open-s")];
holes.forEach((hole, i) => R.items.push({ name: `opening${i}`, key: caseKey + 0.001 * (i + 1), svg: hole.svg, shapes: [] }));
R.items.sort((a, b) => a.key - b.key);
A.auditOrExit(R, P);

// Live data: the camera as affine screen vectors, the card's track, the slots and the model.
const track = [
  [TRAY_C, [TRAY_C[0], TRAY_C[1], Z_AIR], [DRAWER_C[0], DRAWER_C[1], Z_AIR], DRAWER_C],
  [DRAWER_C, [DRAWER_C[0], DRAWER_C[1], Z_AIR], [HOLDER_C[0], HOLDER_C[1], Z_AIR], HOLDER_C],
].map((points) => G.resample(G.fillet(points, 10, 8), 1).map((p) => p.map((v) => Math.round(v * 100) / 100)));
const DATA = {
  ...CAM,
  model: MODEL,
  still: STILL_DAY,
  rest: TRAY_C,
  track,
  slots: [
    { name: "tray", at: TRAY_C, top: SLOT_TOP.tray },
    { name: "drawer", at: DRAWER_C, top: SLOT_TOP.drawer },
    { name: "holder", at: HOLDER_C, top: SLOT_TOP.holder },
  ],
};
const round = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v)));

// The live script: one loop, eased day, card on its track, ink from the model, dial and readout.
function live(root, DATA, strengthOf, readoutOf, dialPose) {
  const M = DATA.model;
  const stage = root.querySelector("[data-stage]");
  const svg = stage.querySelector("svg");
  const readout = root.querySelector("[data-readout]");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const q = (sel) => svg.querySelector(sel);
  const card = q('[data-cab="card"]');
  const sem = q('[data-cab="sem"]');
  const srcs = [...svg.querySelectorAll('[data-cab="src"]')];
  const blade = q('[data-cab="blade"]');
  const ribs = [...svg.querySelectorAll('[data-cab="rib"]')];
  const inks = [...svg.querySelectorAll("[data-ink]")].map((el) => ({ el, kind: el.dataset.ink, age: +el.dataset.age, last: -1 }));
  const slotEls = Object.fromEntries([...svg.querySelectorAll("[data-slot]")].map((el) => [el.dataset.slot, el]));
  const air = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "g"));
  slotEls.air = air;
  const shift = (v) => [v[0] * DATA.ex[0] + v[1] * DATA.ey[0] + v[2] * DATA.ez[0], v[0] * DATA.ex[1] + v[1] * DATA.ey[1] + v[2] * DATA.ez[1]];
  const at = (p) => { const s = shift(p); return [DATA.o[0] + s[0], DATA.o[1] + s[1]]; };
  const lens = DATA.track.map((pts) => pts.reduce((acc, p, i) => (acc.push(i ? acc[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]) : 0), acc), []));
  const along = (u) => {
    const leg = u <= 1 ? 0 : 1;
    const pts = DATA.track[leg];
    const len = lens[leg];
    const want = Math.min(1, Math.max(0, u - leg)) * len[len.length - 1];
    let i = 1;
    while (i < len.length - 1 && len[i] < want) i++;
    const t = (want - len[i - 1]) / (len[i] - len[i - 1] || 1);
    return pts[i - 1].map((v, j) => v + (pts[i][j] - v) * t);
  };
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const settle = (s, target, dt, tau, calm) => {
    if (calm) { s.x = target; s.v = 0; return false; }
    const w = 1 / tau;
    for (let i = 0; i < 4; i++) { s.v += (w * w * (target - s.x) - 2 * w * s.v) * (dt / 4); s.x += s.v * (dt / 4); }
    if (Math.abs(target - s.x) < 1e-4 && Math.abs(s.v) < 1e-4) { s.x = target; s.v = 0; return false; }
    return true;
  };
  const day = { x: DATA.still, v: 0 };
  const pos = { x: 2, v: 0 };
  const merge = { x: 1, v: 0 };
  let target = DATA.still;
  let slot = "holder";
  const cardTarget = (d) => (d < M.file ? 0 : d < M.every ? 1 : 2);
  const tourSteps = [[2, null, null], [2.6, null, 0], [3.4, 0, 0], [2.4, 0, 1], [2.2, 1, 1], [2.4, 1, M.every], [2.4, M.every, M.every], [9, M.every, M.days], [2.6, M.days, M.days], [3, M.days, 0]];
  let tour = { clock: 0, step: 0, from: DATA.still };
  const tourAt = (dt) => {
    tour.clock += dt;
    while (tour.clock > tourSteps[tour.step][0]) {
      tour.clock -= tourSteps[tour.step][0];
      tour.step = tour.step + 1 >= tourSteps.length ? 2 : tour.step + 1;
      tour.from = target;
    }
    const [len, a, b] = tourSteps[tour.step];
    const from = a === null ? tour.from : a;
    const to = b === null ? tour.from : b;
    return from + (to - from) * smooth(0, 1, tour.clock / len);
  };
  const theta = (d) => (d / M.days) * Math.PI * 2;
  const slotOf = (p) => {
    for (const s of DATA.slots) if (Math.hypot(p[0] - s.at[0], p[1] - s.at[1]) < 0.6 && p[2] < s.top) return s.name;
    return "air";
  };
  const say = (d) => readoutOf(d, M, strengthOf);
  const describe = () => {
    const d = Math.round(target);
    stage.setAttribute("aria-valuenow", String(Math.round(d)));
    stage.setAttribute("aria-valuetext", say(d).replace(/ · /g, ", "));
  };
  function draw() {
    const d = day.x;
    const p = along(pos.x);
    const off = shift([p[0] - DATA.rest[0], p[1] - DATA.rest[1], p[2] - DATA.rest[2]]);
    card.setAttribute("transform", `translate(${off[0].toFixed(2)} ${off[1].toFixed(2)})`);
    const next = slotOf(p);
    if (next !== slot) { slotEls[next].appendChild(card); slot = next; }
    const pose = dialPose(theta(d), DATA);
    blade.setAttribute("transform", pose.blade);
    pose.ribs.forEach((rib, i) => { ribs[i].setAttribute("d", rib.d); ribs[i].setAttribute("stroke-opacity", rib.alpha); });
    const m = merge.x;
    const drop = shift([0, 0, (1 - m) * 22]);
    sem.setAttribute("transform", `translate(${drop[0].toFixed(2)} ${drop[1].toFixed(2)})`);
    sem.style.opacity = smooth(0, 0.55, m).toFixed(3);
    const lift = shift([0, 0, 3.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, m)))]);
    srcs.forEach((el) => el.setAttribute("transform", `translate(${lift[0].toFixed(2)} ${lift[1].toFixed(2)})`));
    for (const ink of inks) {
      const s = ink.kind === "recalled" && d < M.file ? 1 : strengthOf(ink.kind, ink.age, d, M);
      if (Math.abs(s - ink.last) > 0.004) { ink.el.setAttribute("opacity", s.toFixed(3)); ink.last = s; }
    }
    const text = say(Math.round(d));
    if (readout.textContent !== text) readout.textContent = text;
  }
  let frame = 0, last = 0, visible = false, touring = !still.matches, paused = false, idle = 0;
  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    const calm = still.matches;
    if (touring && !paused && !calm) target = tourAt(dt);
    let moving = settle(day, target, dt, 0.16, calm);
    // Whole days for discrete state, or the eased approach would hang on day 29.99 before the recall.
    moving = settle(pos, cardTarget(Math.round(day.x)), dt, 0.55, calm) || moving;
    moving = settle(merge, day.x >= M.sleep ? 1 : 0, dt, 0.42, calm) || moving;
    draw();
    frame = visible && (moving || (touring && !paused && !calm)) ? requestAnimationFrame(tick) : 0;
  }
  const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
  const hold = () => {
    touring = false;
    clearTimeout(idle);
    idle = setTimeout(() => { touring = !still.matches; tour = { clock: 0, step: 0, from: target }; run(); }, 5000);
  };
  const steer = (next) => { hold(); target = Math.min(M.days, Math.max(0, next)); describe(); run(); };
  new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
  let drag = null;
  stage.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, from: touring ? day.x : target, id: event.pointerId, moved: false };
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; stage.setPointerCapture(event.pointerId); }
    steer(drag.from + (dx / stage.getBoundingClientRect().width) * M.days);
  });
  const end = (event) => { if (drag && event.pointerId === drag.id) { if (drag.moved) stage.releasePointerCapture(event.pointerId); drag = null; } };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("pointerenter", () => { paused = true; });
  stage.addEventListener("pointerleave", () => { paused = false; run(); });
  stage.addEventListener("focus", () => { paused = true; describe(); });
  stage.addEventListener("blur", () => { paused = false; run(); });
  stage.addEventListener("keydown", (event) => {
    const from = touring ? Math.round(day.x) : target;
    const big = event.shiftKey ? 365 : M.every;
    const keys = { ArrowRight: from + big, ArrowUp: from + big, ArrowLeft: from - big, ArrowDown: from - big, PageUp: from + 365, PageDown: from - 365, Home: 0, End: M.days };
    if (!(event.key in keys)) return;
    event.preventDefault();
    steer(keys[event.key]);
  });
  if (still.matches) { touring = false; }
  describe();
  draw();
}

// Markup, scoped CSS and the component.
const body = R.items.map((item) => item.svg).join("");
const LABEL = "An oak card-catalogue cabinet. A new index card sits in a tray on top, is filed into a drawer pulled half out, and rises into a holder on top when it is recalled. A dial on the side passes the days: cards nobody recalls lose their ink, the recalled card stays dark.";
const svg = k.figureSvg({ width: W, height: H, label: LABEL, body: `<defs>${holes.map((hole) => hole.clip).join("")}</defs>${body}` });
const CSS = `
.cab{--anatomy-paper:var(--cab-paper,#f7f4ee);--anatomy-top:#fdfbf7;--anatomy-face:#ffffff;
--anatomy-shade-0:#dcd3c5;--anatomy-shade-1:#e4ddd1;--anatomy-shade-2:#ebe5db;--anatomy-shade-3:#f2ede5;
--anatomy-lit-top:#ffffff;--anatomy-lit-shade:#f6f2ea;--anatomy-hi:#2b251e;--anatomy-mid:#7b7266;--anatomy-lo:#aca394;
--anatomy-faint:#d3cbbe;--anatomy-lit:#1f1b16;--anatomy-halo:#7d7264;--anatomy-dot:#3b342b;--cab-card:#fdfbf7;--cab-ink:#1f1b16;
position:relative;margin:0;color:#5e554a}
.cab .cab-cave{--anatomy-paper:#e2dacd;--anatomy-top:#e6dfd3;--anatomy-shade-0:#d2c8b8;--anatomy-shade-1:#d8cfc0;--anatomy-shade-2:#ddd5c7;--anatomy-shade-3:#e2dacd;--cab-card:#e8e1d5;--anatomy-mid:#968c7e;--anatomy-lo:#b7ae9f}
.cab-stage{position:relative;outline:none;touch-action:pan-y;cursor:ew-resize;-webkit-tap-highlight-color:transparent}
.cab-stage:focus-visible{outline:1px solid #7b7266;outline-offset:6px}
.cab-corner{position:absolute;font:12px/1 var(--font-geist-mono,ui-monospace),ui-monospace,monospace;color:#5e554a;white-space:nowrap;pointer-events:none}
.cab-corner[data-corner="readout"]{bottom:0;right:0;font-variant-numeric:tabular-nums}
.cab-frame{position:relative;padding:0 0 28px}
.cab .iso-svg{display:block;width:100%;height:auto;overflow:visible;aspect-ratio:${W}/${H}}
.cab .iso-svg path,.cab .iso-svg circle{vector-effect:non-scaling-stroke}
.cab .iso-fill{fill:var(--anatomy-paper);stroke:none}
.cab .iso-shade,.cab .iso-top{stroke:none}
.cab .iso-shade[data-shade="0"]{fill:var(--anatomy-shade-0)}
.cab .iso-shade[data-shade="1"]{fill:var(--anatomy-shade-1)}
.cab .iso-shade[data-shade="2"]{fill:var(--anatomy-shade-2)}
.cab .iso-shade[data-shade="3"]{fill:var(--anatomy-shade-3)}
.cab .iso-top{fill:var(--anatomy-top)}
.cab .iso-halo{fill:var(--anatomy-halo);stroke:none;filter:blur(9px);opacity:.3;transform:translateY(3px)}
.cab .iso-line{fill:none;stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight,.6px);stroke-linecap:round;stroke-linejoin:round}
.cab .iso-line[data-tone="hi"]{stroke:var(--anatomy-hi)}
.cab .iso-line[data-tone="mid"]{stroke:var(--anatomy-mid)}
.cab .iso-line[data-tone="faint"]{stroke:var(--anatomy-faint)}
.cab .iso-dots circle{fill:var(--anatomy-dot);stroke:none;opacity:.45}
.cab .iso-dots[data-tone="hi"] circle{opacity:.85}
.cab .cab-card{fill:var(--cab-card);stroke:var(--anatomy-mid);stroke-width:.6px;stroke-linejoin:round}
.cab .cab-card[data-lit]{fill:var(--anatomy-face);stroke:var(--anatomy-lit);stroke-width:.9px}
.cab .cab-ink path{fill:none;stroke:var(--cab-ink);stroke-width:1.1px;stroke-linecap:round}
.cab .cab-label{fill:var(--anatomy-top);stroke:var(--anatomy-faint);stroke-width:.6px}
.cab .cab-void{fill:var(--anatomy-shade-0);stroke:none}
.cab .cab-blade{fill:var(--anatomy-top);stroke:var(--anatomy-hi);stroke-width:.7px;stroke-linejoin:round}
.cab .cab-ribs path{fill:none;stroke:var(--anatomy-lo);stroke-width:.5px}
`.trim();
const frameHtml = `<div class="cab-frame"><div class="cab-stage" data-stage tabindex="0" role="slider" aria-label="Card cabinet day dial. Drag sideways or use the arrow keys to pass the days." aria-valuemin="0" aria-valuemax="${MODEL.days}" aria-valuenow="${STILL_DAY}">${svg}</div><span class="cab-corner" data-corner="readout" data-readout aria-hidden="true">${readoutOf(STILL_DAY, MODEL, strengthOf)}</span></div>`;
const script = `(${live.toString()})(document.currentScript.parentElement, ${JSON.stringify(round(DATA))}, ${strengthOf.toString()}, ${readoutOf.toString()}, ${dialPose.toString()});`;
const component = `---
// Generated by website/scripts/figure/build-cabinet.mjs: edit that script and run it, not this file.
---
<figure class="cab">${frameHtml}<script is:inline>${script}</script></figure>
<style is:global>${CSS}</style>
`;
writeFileSync(COMPONENT, component);
if (PREVIEW) {
  mkdirSync(PREVIEW, { recursive: true });
  const page = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The card cabinet</title><style>body{margin:0;background:#f7f4ee;font:14px/1.6 system-ui,sans-serif}main{width:min(860px,100% - 32px);margin:48px auto}${CSS}</style></head><body><main><figure class="cab">${frameHtml}<script>${script}</script></figure></main></body></html>`;
  writeFileSync(join(PREVIEW, "card-cabinet.html"), page);
}
const parts = R.items.reduce((n, item) => n + item.shapes.length, 0);
console.log(`wrote ${COMPONENT} · ${R.items.length} items · ${parts} recorded solids · ${(component.length / 1024).toFixed(1)} KB raw`);
