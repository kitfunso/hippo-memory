/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * The one Preact island (client:visible). Animated SVG of a memory's strength over
 * time: exponential decay, re-strengthened by two `recall` events, then decaying
 * again.
 *
 * Robustness: SSR / no-JS renders the curve FULLY DRAWN (visible) - the line is not
 * JS-dependent. JS enhances it with a scroll-triggered draw-in: snap the stroke to
 * "undrawn" off-screen (rAF, no visible flash), enable the transition, then draw it
 * in when scrolled into view. prefers-reduced-motion: leave it drawn and static.
 */
export default function DecayCurve() {
  const ref = useRef<SVGSVGElement>(null);
  const [drawn, setDrawn] = useState(true); // SSR-visible default
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const el = ref.current;
    if (!el || mq.matches) return; // reduced motion: stay drawn + static

    setDrawn(false); // snap to undrawn (transition still off -> instant, off-screen)
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAnimating(true)); // arm transition after snap commits
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setDrawn(true); // draw in
            io.disconnect();
          }
        });
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

  // strength (y: 52 high -> 178 low) over time (x: 24 -> 460); two recall re-strengthens.
  const curve =
    'M24,52 C70,96 112,150 156,156 C162,156 166,144 168,124 C170,98 173,80 180,80 C228,102 276,150 312,158 C318,158 322,146 324,126 C326,100 329,84 336,84 C388,108 440,162 460,178';
  const recalls = [
    { x: 180, y: 80 },
    { x: 336, y: 84 },
  ];
  const LEN = 1100;
  const strokeTransition = animating ? 'stroke-dashoffset 1.8s cubic-bezier(0.22,1,0.36,1)' : 'none';
  const fadeTransition = animating ? 'opacity 0.7s ease 0.3s' : 'none';

  return (
    <svg
      ref={ref}
      viewBox="0 0 484 208"
      role="img"
      aria-label="Memory strength decays over time, re-strengthened by each recall, then decays again."
      class="h-auto w-full"
    >
      <defs>
        <linearGradient id="decayStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#a78bfa" />
          <stop offset="100%" stop-color="#22d3ee" />
        </linearGradient>
        <linearGradient id="decayFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(167,139,250,0.18)" />
          <stop offset="100%" stop-color="rgba(34,211,238,0)" />
        </linearGradient>
      </defs>

      {/* axes */}
      <line x1="24" y1="184" x2="464" y2="184" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
      <line x1="24" y1="20" x2="24" y2="184" stroke="rgba(255,255,255,0.12)" stroke-width="1" />
      <text x="8" y="30" fill="#a1a1aa" font-size="9" font-family="monospace" transform="rotate(-90 8 30)" style="transform-box: fill-box;">strength</text>
      <text x="430" y="200" fill="#a1a1aa" font-size="9" font-family="monospace">time</text>

      {/* area fill under curve */}
      <path
        d={`${curve} L460,184 L24,184 Z`}
        fill="url(#decayFill)"
        opacity={drawn ? 1 : 0}
        style={{ transition: fadeTransition }}
      />

      {/* the decay curve */}
      <path
        d={curve}
        fill="none"
        stroke="url(#decayStroke)"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-dasharray={LEN}
        stroke-dashoffset={drawn ? 0 : LEN}
        style={{ transition: strokeTransition }}
      />

      {/* recall markers */}
      {recalls.map((r, i) => (
        <g opacity={drawn ? 1 : 0} style={{ transition: animating ? `opacity 0.5s ease ${0.9 + i * 0.4}s` : 'none' }}>
          <circle cx={r.x} cy={r.y} r="4.5" fill="#22d3ee" class="decay-dot" />
          <text x={r.x + 8} y={r.y - 4} fill="#a1a1aa" font-size="9.5" font-family="monospace">recall</text>
        </g>
      ))}
    </svg>
  );
}
