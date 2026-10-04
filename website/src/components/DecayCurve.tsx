/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';

// One memory, three futures, from calculateStrength and markRetrieved in src/memory.ts at their defaults.
// Labels are HTML over a stretched SVG so text keeps its size at every width.

type Ev = { day: number; kind: 'recall' | 'wrong' };
type Pt = readonly [day: number, strength: number];

const END = 730;
const TOP = 1.1; // headroom above full strength for the recall labels

function simulate(events: readonly Ev[]): Pt[] {
  let anchor = 0;
  let halfLife = 365;
  let recalls = 0;
  let wrong = 0;
  const at = (d: number) => {
    const reward = wrong ? 1 - (0.5 * wrong) / (wrong + 1) : 1;
    const boost = wrong ? 1 : 1 + 0.1 * Math.log2(recalls + 1);
    return Math.min(1, boost * 0.5 ** ((d - anchor) / (halfLife * reward))) * 0.5 ** Math.min(wrong, 3);
  };
  const pts: Pt[] = [];
  let i = 0;
  for (let d = 0; d <= END; d += 2) {
    while (i < events.length && events[i].day <= d) {
      const e = events[i++];
      pts.push([e.day, at(e.day)]);
      if (e.kind === 'wrong') wrong += 1;
      else if (!wrong) {
        recalls += 1;
        anchor = e.day;
        halfLife += 2;
      }
      pts.push([e.day, at(e.day)]);
    }
    pts.push([d, at(d)]);
  }
  return pts;
}

const RECALLS = [120, 330, 540];
const WRONG_AT = 260;
const SUPERSEDED_AT = 450;

const alone = simulate([]);
const recalled = simulate(RECALLS.map((day) => ({ day, kind: 'recall' }))).filter(([d]) => d >= RECALLS[0]);
const wrongPts = simulate([{ day: WRONG_AT, kind: 'wrong' }]).filter(([d]) => d >= WRONG_AT && d <= SUPERSEDED_AT);
const strengthAt = (pts: Pt[], day: number) => [...pts].reverse().find(([d]) => d === day)?.[1] ?? 0;

const y = (s: number) => (TOP - s) * 100;
const path = (pts: Pt[]) => pts.map(([d, s], i) => `${i ? 'L' : 'M'}${d},${y(s).toFixed(2)}`).join(' ');
const pos = (day: number, s: number) => ({ left: `${(day / END) * 100}%`, top: `${((TOP - s) / TOP) * 100}%` });

const MINT = '#7ce38b';
const AMBER = '#f2b84b';
const GREY = '#9aa79e';

const ticks = [
  { day: 0, label: 'saved' },
  { day: 182, label: '6 mo' },
  { day: 365, label: '1 yr' },
  { day: 547, label: '18 mo' },
  { day: 730, label: '2 yr' },
];

function Dot({ day, s, color }: { day: number; s: number; color: string }) {
  return (
    <span
      class="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-zinc-900"
      style={{ ...pos(day, s), background: color }}
    />
  );
}

export default function DecayCurve() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true); // SSR and no-JS render the finished chart
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setShown(false);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAnimating(true)); // arm the transition only after the hidden state paints
    });
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      io.disconnect();
    };
  }, []);

  const reveal = {
    clipPath: shown ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
    transition: animating ? 'clip-path 1.6s cubic-bezier(0.22,1,0.36,1)' : 'none',
  };
  const fade = (delay: number) => ({
    opacity: shown ? 1 : 0,
    transition: animating ? `opacity 0.5s ease ${delay}s` : 'none',
  });
  const wrongBefore = strengthAt(alone, WRONG_AT);
  const wrongAfter = wrongPts[1][1];
  const supersededS = strengthAt(wrongPts, SUPERSEDED_AT);
  const label = 'absolute whitespace-nowrap font-mono text-xs leading-none';

  return (
    <div
      ref={ref}
      role="img"
      aria-label="Memory strength over two years. Left alone, a memory falls to half strength after a year. Each recall restores it to full. Marked wrong, it halves and fades faster; superseded, it leaves recall."
      class="grid grid-cols-[auto_1fr] gap-x-3"
    >
      <div class="relative h-56 font-mono text-xs text-zinc-400 sm:h-72" aria-hidden="true">
        {[1, 0.5, 0].map((s) => (
          <span class="absolute right-0 -translate-y-1/2" style={{ top: pos(0, s).top }}>{s === 0.5 ? '½' : s}</span>
        ))}
      </div>

      <div class="relative h-56 sm:h-72" aria-hidden="true">
        <svg viewBox={`0 0 ${END} ${TOP * 100}`} preserveAspectRatio="none" class="absolute inset-0 h-full w-full overflow-visible">
          {[1, 0.5].map((s) => (
            <line x1="0" x2={END} y1={y(s)} y2={y(s)} stroke="rgba(255,255,255,0.07)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke" />
          ))}
          <line x1="0" x2={END} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.14)" vector-effect="non-scaling-stroke" />
          <g style={reveal}>
            <path d={path(alone)} fill="none" stroke={GREY} stroke-width="2" stroke-dasharray="5 5" vector-effect="non-scaling-stroke" />
            <path d={path(wrongPts)} fill="none" stroke={AMBER} stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
            <path d={path(recalled)} fill="none" stroke={MINT} stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
          </g>
        </svg>

        <div style={fade(0.9)}>
          {RECALLS.map((day) => <Dot day={day} s={1} color={MINT} />)}
          <span class={`${label} -translate-x-1/2 -translate-y-[calc(100%+10px)] text-acc-violet`} style={pos(RECALLS[0], 1)}>recall</span>
          <Dot day={WRONG_AT} s={wrongBefore} color={AMBER} />
          <span class={`${label} -translate-x-[calc(100%+10px)] -translate-y-1/2 text-acc-amber`} style={pos(WRONG_AT, wrongAfter)}>marked wrong</span>
          <span class="absolute -translate-x-1/2 -translate-y-1/2 text-lg leading-none text-acc-amber" style={pos(SUPERSEDED_AT, supersededS)}>×</span>
          <span class={`${label} -translate-x-1/2 translate-y-[12px] text-acc-amber`} style={pos(SUPERSEDED_AT, supersededS)}>superseded</span>
          <span class={`${label} -translate-x-full translate-y-[8px] text-acc-violet`} style={pos(END, strengthAt(recalled, END))}>recalled</span>
          <span class={`${label} -translate-x-full translate-y-[8px] text-zinc-400`} style={pos(END, strengthAt(alone, END))}>left alone</span>
        </div>
      </div>

      <span />
      <div class="relative mt-2 h-4 font-mono text-xs text-zinc-400" aria-hidden="true">
        {ticks.map((t, i) => (
          <span
            class={`absolute whitespace-nowrap ${i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
            style={{ left: pos(t.day, 0).left }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
