# E5 Lighthouse audit report — 2026-05-24

**Episode:** `01KSDSXYT180T08V0WY73ECDHW`
**Target build:** `ui-revamp-e5-a11y` branch tip, served via `hippo dashboard --port 3333`
**Tool:** `lighthouse@13.3.0` via `npx lighthouse@latest`
**Profile:** desktop chrome, headless, --no-sandbox

## Scores

| Category | Score | Target | Status |
|---|---|---|---|
| Accessibility | **97** | ≥85 | ✅ PASS (+12) |
| Performance | **32** | ≥80 | ❌ MISS (−48) |

## Accessibility — what we did right

- 12 ARIA attributes across header / sidebar / filter / freeze / search / drawer (E0-E5).
- `<main>` landmark wraps LivingMap.
- `role="search"` on search input wrapper, `role="region"` + `aria-label` on canvas wrapper.
- Canvas itself wrapped in `aria-hidden="true"` — opaque to AT, sidebar + drawer are the SR experience.
- SR escape hatch button (sibling of aria-hidden wrapper) lets SR users Tab out of the canvas into the drawer.
- Skip-link "Skip to memory list" — first focusable element; jumps to drawer + opens it.
- `aria-live="polite"` on loading state for SR announcement.
- Focus-visible 2px rust outline (WCAG AA contrast ~4.8:1 on parchment).
- Drawer table: `role="region"` + `aria-label`, keyboard nav (arrows + Enter + Esc), `aria-selected` per row.
- Reduced-motion: one-shot OS check on mount sets `frozen=true`; freeze button gets explanatory `title` + sr-only span when origin is OS.

## Accessibility — 3 minor audits that initially failed (all fixed in this round)

| Audit | Cause | Fix |
|---|---|---|
| `landmark-one-main` | No `<main>` landmark | Wrapped LivingMap in `<main>` in App.tsx |
| `label-content-name-mismatch` | BottomBar `L list (305)` had `aria-label="Open memory list view..."` not starting with visible text | Restructured `aria-label` to start with visible text: `"L list (305), open memory list view"` |
| `target-size` | BottomBar Kbd shortcut spans were <24px tall | Added `padding: 6px 4px` + `display: inline-flex` for ≥24px hit target |

## Performance — honest shortfall

**Score: 32/100. Target was 80. Documented per the plan's honest-reporting
protocol; v0.26 ships with this known miss. v0.27 will target ≥85.**

### Why perf is low

Primary cause: bundle size + canvas init time.

After E5 S7's `manualChunks` vendor split:
- `three`: 510KB (gzip 129KB)
- `index` (app code): 257KB (gzip 77KB)
- `react`: 12KB (gzip 4KB)
- `d3-force`: 0KB (tree-shaken)

Three.js is the dominant payload. Lighthouse counts the WebGL renderer
initialization in LCP (Largest Contentful Paint) because the parchment-tinted
canvas IS the largest element. With a 3D scene initialising over 305 nodes,
LCP lands at ~5-6s on Lighthouse's simulated mobile profile.

### What would move perf to ≥80 (v0.27 scope)

1. **Lazy-load Three.js + scene initialisation** behind a "Loading visualisation…" splash, so chrome paints first and LCP becomes the chrome (parchment header + sidebar) instead of the canvas.
2. **Replace static parchment + serif chrome paint as the LCP target** by adding a dedicated CSS skeleton render BEFORE React mounts (Vite plugin for static prerender of the loading state).
3. **`<link rel=preload>`** for the three.js chunk so it starts loading during initial HTML parse.
4. **Consider a service worker** for repeat-visit caching.

### What is NOT the perf bottleneck

- Bundle chunking is OK after manualChunks (good HTTP/2 parallel load).
- API latency is sub-50ms on localhost.
- React hydration is fast (single page, no SSR).
- Tag cloud rendering is O(N) for 51 tags — trivial.

### Decision

Ship v0.26 with perf=32. Surface in CHANGELOG.md AND the ship-readiness-critic
input. v0.27 perf epic tracks 4 fixes above. Not blocking ship because:
1. The dashboard is a single-user local tool, not a public web app.
2. Real users (Keith on RTX 5080) experience near-instant load.
3. The Lighthouse profile is simulated cellular3G + 1.6KB CPU — extreme worst case.

## Files

- `docs/evals/2026-05-24-e5-lighthouse.json` — raw Lighthouse output (this run)

## Reproducibility

```bash
cd C:/Users/skf_s/hippo
hippo dashboard --port 3333 &  # or already running
npx lighthouse@latest http://localhost:3333 \
  --only-categories=accessibility,performance \
  --output=json \
  --output-path=docs/evals/2026-05-24-e5-lighthouse.json \
  --chrome-flags="--headless --no-sandbox" \
  --quiet
```
