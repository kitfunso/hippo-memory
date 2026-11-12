// Layout for one benchmark's field strip: a published lane of rings over a run-here lane of dots, one shared axis.
export interface Rival { name: string; value: number; diff: number; lo: number; hi: number }
export interface Published { name: string; system: string; value: number; kind: string; src: string }
export interface Bench {
  name: string; unit: string; n: number; hippo: number; file: string;
  rivals: Rival[]; published: Published[]; rank: number | null; field: number | null;
}
type Anchor = 'start' | 'middle' | 'end';
export interface Dot { x: number; y: number; r: number; tone: 'hippo' | 'here' | 'pub'; title: string }
export interface Label { x: number; y: number; text: string; anchor: Anchor; strong: boolean }
export interface Strip {
  w: number; h: number; gridTop: number; gridBottom: number; divY: number; hereY: number;
  ticks: { x: number; v: number; anchor: Anchor }[]; dots: Dot[]; labels: Label[];
}

const CHAR = 7.4; // Geist Mono at 12px, with a little room
// Published values keep their second decimal (93.05 stays 93.05); ours carry one.
export const f1 = (v: number): string => (v.toFixed(2).endsWith('0') ? v.toFixed(1) : v.toFixed(2));
export const fmt = (b: Bench, v: number): string => (b.unit === 'F1' ? `F1 ${f1(v)}` : `${f1(v)}%`);
export const shortName = (b: Bench): string => b.name.replace(/ \(.*\)$/, '');
// Model-alone rows stay in the table only; the published full-chat ceiling stays on the strip.
export const shownPublished = (b: Bench): Published[] => b.published.filter((p) => p.kind !== 'paper-baseline' || p.name === 'Full chat');
export const shownHere = (b: Bench): Rival[] => b.rivals.filter((r) => !r.name.startsWith('hippo'));

/** Stack items whose marks would touch into rows; returns the row count. */
function stack<T extends { x: number; row: number }>(items: T[], gap: number): number {
  const done: T[] = [];
  for (const it of items) {
    it.row = 0;
    while (done.some((d) => d.row === it.row && Math.abs(d.x - it.x) < gap)) it.row++;
    done.push(it);
  }
  return Math.max(0, ...done.map((d) => d.row)) + 1;
}

export function strip(b: Bench, w: number): Strip {
  const pub = shownPublished(b).map((p) => ({ v: p.value, name: p.name, title: `${p.name} ${fmt(b, p.value)}, published (${p.system})`, x: 0, row: 0 }));
  const here = [
    { v: b.hippo, name: 'hippo', title: `hippo ${fmt(b, b.hippo)}, run here`, x: 0, row: 0, me: true },
    ...shownHere(b).map((r) => ({ v: r.value, name: r.name, title: `${r.name} ${fmt(b, r.value)}, run here`, x: 0, row: 0, me: false })),
  ];
  const all = [...pub, ...here].map((d) => d.v);
  const lo = Math.max(30, Math.floor((Math.min(...all) - 2) / 10) * 10);
  const x = (v: number): number => 8 + ((v - lo) / (100 - lo)) * (w - 16);
  for (const d of [...pub, ...here]) d.x = x(d.v);
  pub.sort((a, c) => a.v - c.v);
  here.sort((a, c) => a.v - c.v);
  const pubRows = pub.length ? stack(pub, 14) : 1;
  const hereRows = stack(here, 18);

  const top = 40;
  const divY = top + pubRows * 14 + 8;
  const hereY = divY + 32;
  const dots: Dot[] = [
    ...pub.map((d) => ({ x: d.x, y: top + d.row * 14, r: 5, tone: 'pub' as const, title: d.title })),
    ...here.map((d) => ({ x: d.x, y: hereY + d.row * 18, r: d.me ? 7 : 5, tone: d.me ? ('hippo' as const) : ('here' as const), title: d.title })),
  ];

  const labels: Label[] = [];
  const taken: { y: number; x0: number; x1: number }[] = [];
  const place = (px: number, ys: number[], text: string, strong: boolean): void => {
    const span = text.length * CHAR;
    const anchor: Anchor = px + span / 2 > w ? 'end' : px - span / 2 < 0 ? 'start' : 'middle';
    const x0 = anchor === 'end' ? px - span : anchor === 'start' ? px : px - span / 2;
    const y = ys.find((yy) => !taken.some((t) => t.y === yy && x0 < t.x1 + 8 && t.x0 < x0 + span + 8)) ?? ys[ys.length - 1];
    taken.push({ y, x0, x1: x0 + span });
    labels.push({ x: px, y, text, anchor, strong });
  };
  const base = hereY + (hereRows - 1) * 18 + 26;
  const levels = [base, base + 16, base + 32];
  const me = here.find((d) => d.me)!;
  place(me.x, levels, `hippo ${fmt(b, me.v)}`, true);
  for (const d of here.filter((e) => !e.me).sort((p, q) => q.v - p.v)) place(d.x, levels, `${d.name} ${f1(d.v)}`, false);
  if (pub.length) {
    const best = pub[pub.length - 1];
    place(best.x, [28], `${best.name} ${f1(best.v)}`, false);
  }

  const gridBottom = Math.max(...labels.map((l) => l.y)) + 10;
  const ticks = [];
  for (let v = lo; v <= 100; v += 10) ticks.push({ x: x(v), v, anchor: (v === lo ? 'start' : v === 100 ? 'end' : 'middle') as Anchor });
  return { w, h: gridBottom + 18, gridTop: 20, gridBottom, divY, hereY, ticks, dots, labels };
}

export const ordinal = (n: number): string =>
  n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

/** Top 3 and in the top half of the field: third of three is last, not a podium. */
export const podium = (b: Bench): boolean => b.rank !== null && b.field !== null && b.rank <= 3 && b.rank * 2 <= b.field;
