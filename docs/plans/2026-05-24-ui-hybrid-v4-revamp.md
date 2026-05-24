# UI revamp — port to hybrid-v4 parchment aesthetic (v2)

**Status:** REVISED — addresses plan-eng-critic round 1 verdict (REVISE, score
62, 4 HIGH + 3 MED + 2 LOW must-fix items). Pending round 2 review.
**Date:** 2026-05-24.
**Author:** Claude (Opus 4.7) under Keith's "completely revamp UI/UX, you decide" direction.
**Aesthetic lock:** `mockups/hybrid-v4.html` per the v0.26 roadmap memory pointer.
**Revision history:** v1 → v2 (this doc): plan-eng-critic round 1 fixes folded
in. v1 reachable via `git log -- docs/plans/2026-05-24-ui-hybrid-v4-revamp.md`.

## Why this plan exists

`docs/RESEARCH.md` and the MEMORY pointer flagged a "v0.26 UI port — 15-20d
Three.js + parchment redesign port from mockups/hybrid-v4.html" item. Per
`dev-framework-rl` SKILL.md, a multi-week effort is C-sized and must be
decomposed into A-sized episodes BEFORE running an episode.

## Current state (verified 2026-05-24)

- `ui/` is a React 19 + Vite + Three.js scaffold (name: `hippo-brain-observatory`, v0.1.0).
- `ui/src/App.tsx` (131 lines) loads memories/stats/conflicts/embeddings via REST, renders `LivingMap`. Dark theme (`#0a0c10` bg, purple accent).
- `ui/src/views/LivingMap/` is the main viz; `ui/src/engine/scene.ts` is Three.js + custom particle physics (NOT d3-force despite the package.json dep — drift noted).
- `ui/src/components/` exists; `BrainScene` exposes `setHighlighted(ids: Set<string>)` but **no** `setVisible/setFiltered` API today.
- `src/dashboard.ts` serves the SPA + REST API on `hippo dashboard --port 3333`.
- `ui/index.html` (1.5 kB) is the dark observatory shell.
- `dist-ui/` exists — built SPA assets present.

### Token surface inventory (HIGH #1 fix)

Four divergent token sources exist today. The plan must address all four:

| # | Surface | Current state | Action |
|---|---|---|---|
| 1 | `ui/index.html` `:root` | dark observatory (`#0a0c10`, JetBrains Mono, `#7c5cff` accent) | Replace with parchment tokens in E1 |
| 2 | `src/dashboard.ts` lines ~167-170 inline `:root` | drifted: `#0f1117`, `#6c8cff`, -apple-system | E0 spike picks: delete-and-redirect-to-SPA OR port-in-lockstep |
| 3 | `src/dashboard.ts` lines ~213-257 `dashboardHTML` SSR fallback (full body + classes) | own card/bar/tab classes | Same decision as #2 — bundle |
| 4 | `ui/src/engine/scene.ts` hex literals (`THREE.Color('#050709')` line ~70, PointLight `0x7c5cff` line ~76, conflict edge `0xff4466` line ~288) | hardcoded, not tokenized | E1 introduces a `tokens.ts` constants module imported by scene.ts |

**E1 acceptance includes a CI guard:** a small script greps for `#0a|#0f|#7c5cff|#6c8cff|0x7c5cff|0x6c8cff` outside `ui/src/tokens.ts` and fails if any match. Prevents drift recurrence.

## Target aesthetic (hybrid-v4 distilled)

- **Palette.** Parchment bg (`#f4efe6`), warm text (`#3a3228`), accent rust (`#c45c3c`), three layer tints (buffer `#7c6caf`, episodic `#4a8ca3`, semantic `#5a8f6b`), borders (`#c4b9a8`).
- **Typography.** Georgia / Palatino Linotype serif for body, Consolas / Monaco mono for stats. Small-caps for panel titles.
- **Layout.** Header row (logo + search + stats + freeze) over map (flex 1) + sidebar (340px) with panels.
- **Texture.** 2% opacity cross-hatch on body bg.
- **Map.** Three.js sphere nodes (existing). Per-frame **HTML overlay** for serif node-labels (new — see E4 HIGH #4 fix).

### IN-scope vs DEFERRED mockup features (considerations #2 fix)

Mockup is 2168 lines with rich features. Locked subset for this revamp:

| Feature | E# | In/Defer |
|---|---|---|
| Parchment palette + serif | E1 | IN |
| Cross-hatch body texture | E1 | IN |
| Header (logo + search + stats + freeze) | E2 | IN |
| Sidebar (stats-headline + stat-rows + filters + tag cloud) | E3 | IN |
| Map area with serif node-labels overlay | E4 | IN |
| a11y + reduced-motion + lighthouse | E5 | IN |
| Timeline scrubber (mockup line ~1500) | — | DEFERRED to v0.27 |
| Minimap | — | DEFERRED |
| Hover preview (rich) | — | DEFERRED — basic tooltip from existing pattern |
| Lineage chips | — | DEFERRED |
| Drawer (mockup lines ~459-469) | E5 | IN — needed as a11y mirror of canvas (HIGH #6) |
| Snapshot button | — | DEFERRED |
| Decay canvas tooltip | — | DEFERRED |
| Copy toast | — | DEFERRED |

## Episode breakdown

### E0 — Token consolidation spike + test infra bootstrap (~1d) **[v2: +0.5d for round-2 MED #3/#4]**

**Scope.**
- Grep all hex literals + `var(--*)` references across `ui/src/`, `src/dashboard.ts`, `ui/index.html`.
- Produce `ui/src/tokens.ts` (constants module: `COLOR_BG`, `COLOR_ACCENT`, `COLOR_BUFFER`, etc.) for engine consumption.
- Produce `ui/src/tokens.css` (the same values as CSS custom properties) imported by `ui/index.html`.
- Produce migration map: `docs/plans/2026-05-24-ui-token-migration-map.md` showing every existing hex → new token name.
- **Decision required during E0:** delete `dashboardHTML` SSR fallback OR port it to parchment. Recommendation: **delete** because `dist-ui/` already exists; the `hippo dashboard` route should serve the built SPA and 404 on missing assets (rare edge case). Document choice in migration map.
- **Test infra bootstrap (round-2 HIGH #3):** append to `ui/package.json` devDeps: `vitest`, `jsdom`, `@vitest/ui`, `@testing-library/react`, `pixelmatch`, `pngjs`, `playwright`. Add `"test": "vitest run"` to scripts. Create `ui/vitest.config.ts` with jsdom env + setup file.
- **Baseline screenshot capture (round-2 MED #4):** run `npx playwright screenshot mockups/hybrid-v4.html --viewport-size=1440,900 --output mockups/hybrid-v4-baseline.png` and commit. Record viewport + chrome version in `mockups/hybrid-v4-baseline.txt` for reproducibility.

**Acceptance.**
- Migration map exists; tokens.ts + tokens.css both compile.
- `cd ui && npm install && npx playwright install chromium && npm test` exits 0 (zero tests OK at this stage, but the command runs). **(round-3 consideration #1: playwright chromium is a ~500MB one-time post-install — name it explicitly so a junior doesn't hit "browser not installed" at baseline capture.)**
- `mockups/hybrid-v4-baseline.png` + `.txt` committed.
- No behavioral change yet (E1 implements the swap).

### E1 — Apply parchment tokens across all 4 surfaces (~1.5d) **[v2: +0.5d for HIGH #1]**

**Scope.** Implement the migration map from E0:
- `ui/index.html` `:root` rewritten using tokens.css.
- `ui/src/engine/scene.ts` hex literals replaced with imports from `ui/src/tokens.ts`.
- `src/dashboard.ts` per E0 decision:
  - **If delete path:** strip the inline `:root` block + `dashboardHTML` SSR fallback; route serves built SPA only.
  - **If port-in-lockstep path:** `src/dashboard.ts` reads token values from a generated `dist-ui/tokens.json` at request time, OR replaces the inline CSS string with `import { TOKENS_CSS } from '../ui/dist/tokens.css?inline'` resolved at build time.
- New `scripts/check-token-drift.mjs` that greps for legacy dark hex codes outside `tokens.ts` / `tokens.css`. Wire into `npm test` or pre-commit.

**Out of scope.** No layout changes, no new components. Engine surface API unchanged.

**Acceptance.**
- Build clean (`cd ui && npm run build`).
- `hippo dashboard` boots, existing LivingMap renders against new tokens.
- `node scripts/check-token-drift.mjs` exits 0 (no legacy hex outside tokens).
- **CI guard scope per E0 decision (round-2 MED #5):**
  - If delete path: guard rejects any `--bg / --accent / --surface / --border` reference inside `src/dashboard.ts`.
  - If port-in-lockstep path: guard rejects any literal hex in `src/dashboard.ts` AND verifies `dist-ui/tokens.json` (or `?inline` import) exists.
- Vitest pass on existing backend tests (no regressions in dashboard server).
- Manual: side-by-side screenshot before/after on a seeded DB to confirm engine behavior unchanged.

**Critic gates.** `plan` → already done (this doc). `execute` → `code-review-critic`. `review` → `independent-review-critic`. **Ships as its own PR** — does NOT bundle into E2 (LOW #2 fix; bundling defeats the "ships first, fail-fast on engine break" mitigation).

### E1.5 — Engine-surface API extension audit (~0.5d) **[new in v2 — MED #1 fix]**

**Scope.** One-shot audit of scene.ts + particles.ts + layout.ts:
- Identify all animation loops. **Verified for current scene.ts:** uses `requestAnimationFrame(this.animate)` + `cancelAnimationFrame(this.rafId)` at lines ~46, ~403, ~405, ~429. Does NOT use Three.js `setAnimationLoop`. Match this existing pattern; do NOT introduce `setAnimationLoop` in parallel.
- Add a single `BrainScene.setReducedMotion(reduced: boolean)` method that all of {E2 freeze-toggle, E5 reduced-motion} call through. Implementation (round-2 HIGH #1 fix):
  ```ts
  setReducedMotion(reduced: boolean): void {
    if (reduced) {
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
      this.snapParticlesToFinal(); // new helper; see below
    } else if (!this.rafId) {
      this.animate(); // restart the existing loop
    }
  }
  ```
  Add `snapParticlesToFinal()` private helper. **NOTE (round-3 HIGH #1 fix):** scene.ts current physics is `node.basePosition + sin(elapsed * driftSpeed) * 0.15` at lines ~L410-L422 — pure oscillation that never converges, so "iterate until delta < epsilon" would either spin forever or stop at an arbitrary phase. Real implementation:
  ```ts
  private snapParticlesToFinal(): void {
    for (const node of this.nodes) {
      node.mesh.position.copy(node.basePosition);
      if (node.halo) node.halo.position.copy(node.basePosition);
    }
    this.composer.render(); // one final paint so reduced-motion users see the static layout
  }
  ```
- Add `BrainScene.setFiltered(ids: Set<string>)` method that toggles mesh `visible` for filtered-out nodes. **Layout is NOT re-run** when filtering — filtered nodes are hidden in place. Document this in the JSDoc.
- Add `BrainScene.onRender(cb: (camera, scene) => void)` for E4's per-frame label overlay (HIGH #4 fix). Implementation: maintain `private onRenderCbs: Array<(c, s) => void> = []` + a `pushOnRender(cb): () => void` (returns unsubscribe). Insert single line in existing `animate()` method at scene.ts ~L403: `this.onRenderCbs.forEach(cb => cb(this.camera, this.scene));`. **This single-line insertion IS in-scope (round-2 LOW #7 carve-out);** refactoring `animate()` itself (loop structure, frame timing, post-processing order) is NOT.
- Add `BrainScene.getCamera(): THREE.PerspectiveCamera` getter so E4's label overlay can call `vector.project(camera)` without reaching into private fields. **(round-3 LOW #4: return type matches actual field type, not wider `THREE.Camera` base.)**

**Out of scope.** No layout algorithm changes. No particle physics constant changes. No render-order changes. The hot-path edits are: one-line `forEach` insert in `animate()`, plus `setReducedMotion` early-return. Anything beyond these = STOP signal.

**Acceptance.** Three new methods exist on `BrainScene`, each with vitest-jsdom unit test (mocked Three.js where needed). Existing scene tests still pass.

**Rationale.** Plan v1 claimed "no engine internals" but E2/E3/E4/E5 all needed extensions. v2 separates surface extension (in-scope, in E1.5) from internals (out-of-scope: layout algorithm, physics constants, render order).

### E2 — Header / search / freeze-toggle (~1d)

**Scope.** New components in `ui/src/components/`:
- `Header.tsx`: 3-col grid (logo + search + stats + freeze button).
- Wires search input → `useDebouncedValue(query, 150)` → `scene.setHighlighted(matchingIds)` (LOW #1 fix).
- Wires freeze toggle → `scene.setReducedMotion(toggleState)` (from E1.5).

**Shared state container.** Use React `useState` lifted to `App.tsx` + prop-drilled (no context, no Zustand — small enough that prop-drilling is honest). Filter shape locked in this episode:
```ts
type FilterState = {
  query: string;            // E2 search
  layers: Set<Layer>;       // E3
  strengthRange: [number, number]; // E3
  confidences: Set<Confidence>;     // E3
  ageMaxDays: number | null;        // E3
  frozen: boolean;          // E2 freeze toggle
};
```
E3 extends but does NOT rename. (considerations #1 fix)

**Acceptance.** Header renders. Type a 10-char search query → `scene.setHighlighted` called at most twice (verified by vitest-jsdom). Freeze button toggles `BrainScene.setReducedMotion`; visual confirmation: simulation stops.

### E3 — Sidebar redesign + filter state (~2.5d) **[v2: +0.5d for MED #3 tests]**

**Scope.** New components:
- `Sidebar.tsx`: panel container.
- `StatsPanel.tsx`: stats-headline + per-layer stat-rows with bars.
- `FilterPanel.tsx`: layer checkboxes, strength range slider, confidence multi-select, age slider.
- `TagCloud.tsx`: tag-frequency sort, click-to-filter (extends `FilterState.query` with `tag:X` syntax).

**Wiring.** Filters update `FilterState` in App. Each filter change derives the visible-id set; passed to `scene.setFiltered(ids)` (from E1.5). Re-render is React-driven; engine layout untouched.

**Tests (MED #3 fix — new in v2).** `ui/vitest.config.ts` introduced with jsdom env. Add to root `package.json` workspaces script. Tests required:
- `FilterPanel.test.tsx`: every filter combination (layer-only, strength-only, layer+strength, etc.) produces the correct visible-id set against a fixed memory fixture.
- `TagCloud.test.tsx`: frequency-sort, top-N truncation, click handler invoked with `tag:X` query.
- `Header.test.tsx`: 150ms debounce honored (use vitest fake timers).

**Acceptance.** All filters wire end-to-end. Stats numbers match REST `/v1/stats`. Vitest-jsdom pass. Manual: 3-filter combination matches expected nodes in viewport.

### E4 — Map polish with HTML label overlay (~3-4d) **[v2: +1d for HIGH #4]**

**Scope.**
- Canvas background → parchment color (`renderer.setClearColor(COLOR_PARCHMENT, 1)`) + body cross-hatch behind canvas.
- **HTML node-label overlay** (HIGH #4 fix, with round-2 HIGH #2 API correction): new `LabelOverlay.tsx` that subscribes to `scene.onRender((camera) => { ... })` (from E1.5). Implementation per `THREE.Vector3.prototype.project` (the actual Three.js API):
  ```ts
  // Class-level scratch to avoid per-frame allocation
  private scratch = new THREE.Vector3();
  // Per-frame
  for (const node of visibleNodes) {
    this.scratch.set(node.x, node.y, node.z);
    this.scratch.project(camera);
    if (Math.abs(this.scratch.x) > 1 || Math.abs(this.scratch.y) > 1 || this.scratch.z < -1 || this.scratch.z > 1) continue; // round-3 LOW #3 fix: symmetric NDC cull including near-plane crossing
    const screenX = (this.scratch.x * 0.5 + 0.5) * canvasW;
    const screenY = (-this.scratch.y * 0.5 + 0.5) * canvasH;
    // ...update label DOM position
  }
  ```
  Throttled to 60fps max via `requestAnimationFrame`. Diff-friendly: keys by memory id, only updates moved labels.
- Map-tooltip → small-caps layer label, parchment bg, accent border on hover.
- Map-hint footer ("DRAG TO PAN") in mono dim.

**Performance constraints.** With N=1000 nodes, label overlay must update in <8ms per frame to maintain 60fps. Acceptance test: `performance.now()` measurement around overlay update on a 1000-memory seed. **Off-screen culling required** (round-2 consideration): nodes with `z > 1` (behind camera) or `|x|>1 || |y|>1` (outside NDC) skip DOM updates entirely.

**Out of scope.** Layout algorithm. Particle physics. Camera controls (use existing).

**Acceptance (HIGH #3 fix — concrete, verifiable).** Replaces the v1 "~5% visual diff" hand-wave with:
1. **Chrome screenshot diff:** `playwright screenshot ui/dist/index.html` (with seeded DB) → produces PNG → `pixelmatch` against `mockups/hybrid-v4-baseline.png` excluding canvas region → threshold ≤ 5% per-channel difference on the chrome (header + sidebar + bottom-bar). Tool: `pixelmatch` npm package + small wrapper script `scripts/screenshot-diff.mjs`. Baseline screenshot committed under `mockups/hybrid-v4-baseline.png` (one-time capture from the mockup).
2. **Canvas region assertion (vitest-jsdom):** assert `renderer.getClearColor().getHex() === 0xf4efe6` (parchment); assert any `.node-label` DOM has computed `font-family` containing `Georgia`; assert `.node-label.selected` computed `border-color` matches `var(--accent)` resolved.
3. **Label overlay perf:** with 1000-memory seed, overlay update per-frame <8ms (asserted via vitest perf hook).

### E5 — a11y, reduced-motion, drawer, lighthouse (~2d) **[v2: +0.5d for HIGH #6 drawer]**

**Scope.**
- Keyboard nav: Tab through filters, Enter on node-labels, arrow keys to navigate visible nodes.
- Focus rings on interactive elements (`outline: 2px solid var(--accent)`).
- `prefers-reduced-motion` media query → `scene.setReducedMotion(true)` on mount (uses E1.5 method).
- ARIA: `role="search"` on input, `role="region" aria-label="Memory graph"` on canvas wrapper, `aria-hidden="true"` on the canvas element itself.
- **Drawer mirror (HIGH #6 fix — new in v2):** port mockup lines ~459-469 drawer pattern. Hidden offscreen `<ul>` of memory IDs + contents, filterable, navigable via keyboard. Acts as the screen-reader-accessible mirror of the canvas. Toggle visible/offscreen via skip-link "Skip to memory list".

**Acceptance.**
- Lighthouse audit on the chrome regions (header + sidebar + drawer when visible): target **≥ 90 accessibility**. The canvas region is `aria-hidden`; the drawer provides the SR-accessible mirror.
- Lighthouse performance: target ≥ 80.
- Manual keyboard walkthrough: complete a filter+select flow without mouse.

**Final PR closes the revamp.** `docs/CHANGELOG.md` entry, `ui/package.json` 0.1.0 → 0.2.0, README screenshot refresh (**both** before/after; considerations #5 fix).

## Risks + mitigations (revised)

| Risk | Mitigation |
|---|---|
| E3/E4 scope creep into engine internals | Engine surface API frozen in E1.5; touching layout/physics/render-order = STOP signal, separate plan. |
| Token surface drift (4 sources, not 2) | E0 produces migration map; E1 lands ts+css single source; `scripts/check-token-drift.mjs` blocks drift. |
| Per-frame label overlay perf with 1000 nodes | E4 acceptance includes perf assertion (<8ms/frame); fallback: throttle to 30fps if 60fps unsustainable. |
| Lighthouse a11y unrealistic with canvas | E5 drawer mirror provides SR-accessible content; canvas itself `aria-hidden`; 90+ target measured on chrome regions only. |
| Worktree collision (6 active agent-* worktrees) | Pre-flight check below now has explicit `git log` command (MED #4 fix). |
| Sub-test fixtures unstable | E3 tests use a fixed in-memory fixture (`tests/fixtures/ui-filter-memories.json`); REST mocking via vi.fn. |
| dashboardHTML SSR fallback drift | E0 decides: delete OR port-in-lockstep. Both options eliminate drift. |
| E2 search recomputes on every keystroke | 150ms debounce via `useDebouncedValue` hook. Asserted by Header.test.tsx. |
| Mockup is WebGL but plan said "canvas-2d" | E4 uses existing Three.js renderer; "parchment canvas" = WebGL clearColor + CSS body bg, two layers stated explicitly. |
| d3-force is used by `ui/src/engine/layout.ts` (NOT scene.ts) | **(round-3 HIGH #2 fix.)** Do NOT remove from package.json — `layout.ts` L1-L8 imports `forceSimulation, forceManyBody, forceCollide, forceX, forceY` and L48-L63 uses them for the initial 2D layout. Document the scene-vs-layout distinction in the migration map so future drift-audits don't repeat the round-2 error. |

## Worktree collision pre-flight check (MED #4 fix; round-2 LOW #6 shell portability)

Run before opening any episode PR, after any rebase, and at episode start. Two
variants — pick whichever matches the shell you're in. Drop
`scripts/check-token-drift.mjs` from the path filter until after E1 lands (it
doesn't exist pre-E1).

**Bash:**
```bash
BRANCH_START=$(git log -1 --format=%cI HEAD)
git log master --since="$BRANCH_START" -- src/dashboard.ts ui/ | head
```

**PowerShell:**
```powershell
$branchStart = git log -1 --format=%cI HEAD
git log master --since="$branchStart" -- src/dashboard.ts ui/ | Select-Object -First 10
```

**Post-E1, add `scripts/check-token-drift.mjs` to the path filter.**

- Non-empty output → rebase episode branch on master AND re-run E1 token-drift check AND re-snapshot the baseline if hybrid-v4-baseline.png is affected.
- Empty output → safe to proceed.

## Out of scope (do NOT do in this plan)

- Layout algorithm, particle physics, render-order internals.
- New REST endpoints — UI consumes existing `/v1/stats` etc.
- Mobile / responsive — desktop-first per mockup.
- Dark-mode toggle — parchment is the new default.
- Other mockup ports.
- Mockup features marked DEFERRED in the feature table above.

## Total estimate (revised — round 2 incorporates +0.5d E0 for test infra bootstrap + baseline PNG capture)

**9.5-12.5 days** across 7 episodes (E0 + E1 + E1.5 + E2 + E3 + E4 + E5):
- E0: 1d (was 0.5d in round-1 v2; bumped for test infra + baseline PNG per round-2 HIGH #3 / MED #4)
- E1: 1.5d
- E1.5: 0.5d
- E2: 1d
- E3: 2.5d
- E4: 3-4d
- E5: 2d

v0.26 roadmap memory said 15-20d. Engine reuse + scoped episodes get this to 9.5-12.5d realistic. v1's "7-9d" was optimistic; round 2 honors test infra cost + baseline PNG production.

## Pre-flight checks before E0

- [ ] `/plan-eng-review` clean on this v2 (round 3 dispatch pending after round-2 fixes applied 2026-05-24).
- [x] Pre-reg cards 1-4 status update committed (2026-05-24).
- [x] Card 4 20-seed eval result captured (2026-05-24 17:43 — PASS, lateMean=0.25, 20/20 non-zero, `docs/evals/2026-05-24-card4-20seed-result.json`).
- [ ] Worktree-collision check run on master HEAD — confirm none of 6 worktrees touched `ui/` or `src/dashboard.ts` since branch.
- [ ] `ui/` build clean from scratch (`cd ui && npm install && npm run build`).

## Sign-off

Keith approves this v2 by replying "apply" or "E0-go" after round 2 critic
returns. If round 2 also REVISEs, fold those fixes and run round 3 (cap at 3
rounds per `/dev-framework-rl` plan-stage policy).
