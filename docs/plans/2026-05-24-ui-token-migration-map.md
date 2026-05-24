# UI token migration map — dark observatory → parchment hybrid-v4

**Companion to** `docs/plans/2026-05-24-ui-hybrid-v4-revamp.md` (E0 deliverable).
**Aesthetic source:** `mockups/hybrid-v4.html`.
**Token files:** `ui/src/tokens.ts` (TS constants), `ui/src/tokens.css` (CSS vars).

## Surface inventory (pre-revamp)

Four divergent token sources existed. **All four converge on tokens.ts/css after E1.**

| # | Surface | Pre-revamp state | Post-E1 state |
|---|---|---|---|
| 1 | `ui/index.html` `:root` | 13 dark observatory tokens | imports `tokens.css` |
| 2 | `src/dashboard.ts` lines 167-171 inline `:root` | 10 drifted tokens (different from #1) | **deleted** per E0 decision below |
| 3 | `src/dashboard.ts` `dashboardHTML(data)` function (lines 159-457) | full SSR dashboard with inline CSS + body | **deleted** per E0 decision below |
| 4 | `ui/src/engine/*` hex literals | particles.ts (5), types.ts (3), scene.ts (5) | imports from `tokens.ts` |

## E0 decision: SSR fallback path

**Chosen: DELETE.** The `dashboardHTML` SSR function at `src/dashboard.ts:159-457` and its caller at line 465 (`res.end(dashboardHTML(data))`) are removed in E1. The `/dashboard` route serves the built SPA from `dist-ui/` instead.

**Justifications:**
- `dist-ui/` already exists with the React SPA built; the SSR HTML duplicated stale UX.
- The SSR dashboard never tracked the dark-observatory `:root` in `ui/index.html` — its tokens drifted (see Source 2 table below). Maintaining parity post-revamp was strictly negative value.
- The hybrid-v4 mockup is fundamentally interactive (force-graph, filters, drawer) — that's SPA territory; the SSR table-of-stats was a v0.1 stopgap.
- Code deletion: ~300 lines of inline HTML/CSS/JS removed.

**Rejected alternative (port-in-lockstep):** would have required either (a) generating `dist-ui/tokens.json` at build time and reading it from the route handler, or (b) `import { TOKENS_CSS } from '../ui/dist/tokens.css?inline'` resolved at build time. Both options possible but neither justified by user need.

**E1 route update:** `/dashboard` becomes a static file handler returning `dist-ui/index.html` (or 404 if absent — direct users to `npm run build` in `ui/`).

## Source 1: ui/index.html `:root`

| Old token | Old value | New token | New value | Notes |
|---|---|---|---|---|
| `--bg` | `#0a0c10` | `--bg` | `#f4efe6` | parchment body bg |
| `--surface` | `#14161e` | `--surface` | `#f0ebe0` | warmer; role narrowed to panel/tag bg |
| `--border` | `rgba(255,255,255,0.06)` | `--border` | `#c4b9a8` | parchment border, solid |
| `--text` | `#e1e4ed` | `--text` | `#3a3228` | INVERTED — light→dark |
| `--muted` | `#6b7084` | `--dim` (also `--muted` alias) | `#9b8e7e` | warm grey |
| `--accent` | `#7c5cff` | `--accent` | `#c45c3c` | purple→rust |
| `--green` | `#34d399` | `--green` | `#5a8f6b` | maps to `--semantic` |
| `--yellow` | `#f0a030` | `--yellow` | `#b8983e` | warmer for parchment |
| `--red` | `#f87171` | `--red` | `#c45c3c` | maps to `--accent` (rust reads as warning on parchment) |
| `--purple` | `#a78bfa` | `--purple` | `#7c6caf` | maps to `--buffer` |
| `--font-mono` | `'JetBrains Mono', 'Fira Code', monospace` | `--font-mono` | `"Consolas", "Monaco", monospace` | system mono |
| `--font-body` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | `--font-body` (aliased to `--font-serif`) | `Georgia, "Palatino Linotype", serif` | sans→serif |
| `--glass-bg, --glass-blur, --glass-border` | (3 tokens) | DELETED | — | glassmorphism not in hybrid-v4 aesthetic |

**New tokens added (no pre-revamp equivalent):**

| Token | Value | Purpose |
|---|---|---|
| `--map-bg` | `#faf7f2` | lighter parchment for map area |
| `--buffer` | `#7c6caf` | layer tint (muted purple) |
| `--episodic` | `#4a8ca3` | layer tint (blue — was orange) |
| `--semantic` | `#5a8f6b` | layer tint (muted green) |
| `--accent-dim` | `#a04832` | conflicts, errors (darker rust) |
| `--radius-sm/md/lg` | `2/3/6px` | sharper corners than old `8px` |
| `--texture-cross-hatch` | gradient | body bg texture |

## Source 2: src/dashboard.ts inline `:root` (drift exhibit)

This is the silent drift the round-1 plan-eng-critic caught. All 10 tokens **deleted** (route serves SPA instead).

| Token | dashboard.ts pre-revamp | ui/index.html pre-revamp | Match? |
|---|---|---|---|
| `--bg` | `#0f1117` | `#0a0c10` | ❌ |
| `--surface` | `#1a1d27` | `#14161e` | ❌ |
| `--border` | `#2a2d3a` (solid) | `rgba(255,255,255,0.06)` | ❌ |
| `--text` | `#e1e4ed` | `#e1e4ed` | ✓ |
| `--muted` | `#8b8fa3` | `#6b7084` | ❌ |
| `--accent` | `#6c8cff` | `#7c5cff` | ❌ |
| `--green` | `#4ade80` | `#34d399` | ❌ |
| `--yellow` | `#fbbf24` | `#f0a030` | ❌ |
| `--red` | `#f87171` | `#f87171` | ✓ |
| `--purple` | `#a78bfa` | `#a78bfa` | ✓ |

**3/10 matched, 7/10 drifted.** The drift was silently accruing because no CI guard existed. E1's `scripts/check-token-drift.mjs` prevents recurrence.

## Source 4: engine hex literals

Each file's hex literals map to a `tokens.ts` import.

### `ui/src/engine/types.ts` (L17-19)

```ts
// PRE
export const LAYER_COLORS = {
  buffer: "#7c5cff",
  episodic: "#f0a030",
  semantic: "#34d399",
};

// POST (E1 — replaced by re-export from tokens.ts)
export { LAYER_COLORS, LAYER_COLORS_HEX } from '../tokens.js';
```

### `ui/src/engine/scene.ts`

| Line | Pre | Post (import from tokens) |
|---|---|---|
| 70 | `new THREE.Color("#050709")` | `new THREE.Color(COLOR_BG)` |
| 71 | `new THREE.FogExp2("#050709", 0.012)` | `new THREE.FogExp2(COLOR_BG, 0.008)` — lighter fog for parchment |
| 73 | `new THREE.AmbientLight(0x111122, 0.5)` | `new THREE.AmbientLight(COLOR_AMBIENT_LIGHT_HEX, 0.65)` — warmer + brighter |
| 76 | `new THREE.PointLight(0x7c5cff, 0.4, 100)` | `new THREE.PointLight(COLOR_ACCENT_HEX, 0.4, 100)` |
| 118 | `new THREE.LineBasicMaterial({ color: 0xffffff, ... opacity: 0.03 })` | `{ color: COLOR_GRID_HEX, ... opacity: 0.06 }` — slightly more visible on parchment |
| 288 | `color: 0xff4466` | `color: COLOR_CONFLICT_HEX` |

### `ui/src/engine/particles.ts`

| Line | Pre | Post |
|---|---|---|
| 112 | `bg.addColorStop(0, "#0c0e14")` | `bg.addColorStop(0, COLOR_BG_GRADIENT_INNER)` |
| 113 | `bg.addColorStop(0.6, "#080a10")` | `bg.addColorStop(0.6, COLOR_BG_GRADIENT_MID)` |
| 114 | `bg.addColorStop(1, "#050709")` | `bg.addColorStop(1, COLOR_BG_GRADIENT_OUTER)` |
| 237-239 | `#ff4466` (3 stops) | `COLOR_CONFLICT_HEX` rendered as hex string (3 stops) |

## d3-force scope (round-3 HIGH #2 correction)

`d3-force` is **actively used** by `ui/src/engine/layout.ts` lines 1-8 (imports) + 48-63 (forceSimulation setup). It is NOT a dead dep.

The earlier risk-row "remove from package.json" was based on grepping scene.ts only and missing layout.ts. **Do not remove `d3-force` from `ui/package.json`.** Document the scene-vs-layout distinction:
- `scene.ts` uses Three.js + custom particle physics (no d3-force).
- `layout.ts` uses d3-force for initial 2D node placement before scene.ts hands over to physics.

This distinction stays during the revamp.

## Test infra bootstrap (E0 sub-deliverable)

Added to `ui/package.json` devDeps (verified installed 2026-05-24):
- `vitest` — test runner
- `jsdom` — DOM environment for component tests
- `@vitest/ui` — interactive runner
- `@testing-library/react` — component testing helpers
- `@testing-library/jest-dom` — DOM matchers
- `pixelmatch` — pixel diff for E4 screenshot baselines
- `pngjs` — PNG decode for pixelmatch
- `playwright` — headless browser for baseline PNG capture + E4 screenshots

Added scripts:
- `"test": "vitest run"` (runs once)
- `"test:watch": "vitest"` (watch mode)
- `"test:ui": "vitest --ui"` (browser runner)

Bootstrapped configs:
- `ui/vitest.config.ts` — jsdom env, includes `src/**/*.test.{ts,tsx}`, coverage config
- `ui/vitest.setup.ts` — imports `@testing-library/jest-dom/vitest`

## E0 → E1 handoff

E1 implements the swap. E1's deliverables (already specified in plan §E1):
1. Rewrite `ui/index.html` `:root` to import `tokens.css`.
2. Update `ui/src/engine/scene.ts` + `particles.ts` + `types.ts` to import from `tokens.ts`.
3. Delete `dashboardHTML()` function and its caller in `src/dashboard.ts`; update `/dashboard` route to serve `dist-ui/index.html`.
4. Add `scripts/check-token-drift.mjs` CI guard.
5. Verify: `cd ui && npm run build` clean; `hippo dashboard` boots; manual screenshot before/after.

## Audit trail

- Token grep timestamp: 2026-05-24
- Auditor: Claude (Opus 4.7) under `/dev-framework-rl` episode `01KSDD8S6KXQPQDHJEYPP5N9ZQ`
- Reviewer: plan-eng-critic R1-R3 (caught drift at R1, refined surface count, prevented d3-force-removal regression at R3)
