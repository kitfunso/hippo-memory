# E5 plan v2 — a11y + drawer mirror + lighthouse + final ship

**Episode:** `01KSDSXYT180T08V0WY73ECDHW` (separate from coordination episode
`01KSDD8S6KXQPQDHJEYPP5N9ZQ` which covers the parent revamp).
**Date:** 2026-05-24.
**Brainstorm:** `docs/plans/2026-05-24-e5-brainstorm.md` (Option D picked: hybrid drawer).
**Revision history:** v1 → v2 (this doc): folds 14 must-fix items from plan-eng-critic R1 (REVISE 82) + plan-design-critic R1 (PASS 87 with 9 micro-specs).
**Sign-off:** pending plan-eng R2 + plan-design R2.

## Mission

Close the UI hybrid-v4 revamp. Make the dashboard usable for keyboard-only
users + screen-reader users without ripping out the canvas. Hit Lighthouse
≥85 a11y on the chrome regions and ≥80 perf overall. Drawer mirror is the
SR-accessible alternative to the canvas. Mark `ui/package.json` 0.2.0,
add CHANGELOG entry, refresh README screenshots.

## Scope

### S1 — Drawer component (~1.3d) [v2: +0.3d for empty-state + table CSS lock-in + camera offset]

**State location (eng-critic HIGH):** `drawerOpen: boolean` is transient UI state, NOT a filter — it does NOT go in `FilterState`. Lives in `LivingMap.tsx` alongside the existing `selectedMemory` useState (L123). App.tsx unaware. SkipLink also moves into LivingMap so it can call `setDrawerOpen` directly (no callback-drilling through App).

**Props (6, matches DetailPanel shape):** `memories`, `visibleIds`, `filterActive`, `open: boolean`, `onClose: () => void`, `onMemorySelect: (m: Memory) => void`.

New `ui/src/components/Drawer.tsx`:

- Container slides up from bottom **to a fixed 280px height** (matches mockup line 192). The top portion of the canvas remains visible above the drawer when open. Toggles between hidden (`translateY(100%)`) and visible (`translateY(0)`). Always renders to DOM (CSS transform only, not `display:none`) so SR users always have access.
- Wrapper: `<div role="region" aria-label="Memory list view">`. Internal `<table>` without default browser borders.

**Table CSS lock-in (design-critic LOW #7):**
- Headers: `font: small-caps 10px var(--font-serif); letter-spacing: 0.6px; color: var(--dim);` (matches mockup line 202)
- Rows: 28px tall with `7px 20px` padding; `border-left: 2px solid transparent` (becomes `var(--accent)` on selection); hover `background: rgba(196, 185, 168, 0.12)`
- Columns: id (10ch mono `var(--dim)`) · content (ellipsis at 55 chars, serif 12px `var(--text)`) · layer (7px colored dot only, no text — too small to scan at row-density) · strength (mono 12px numeric) · age (`Nd` mono 12px `var(--dim)`)
- Mini-bar inside strength cell DEFERRED to v0.27

**Selected-row affordance (design-critic MED #4):** `aria-selected="true"` + `border-left: 2px solid var(--accent)` (left only, NOT all-around) + `background: rgba(196, 92, 60, 0.06)`. Matches mockup lines 209-212. Left-border-only reads as "currently inspecting" (IDE-gutter pattern); the all-around 2px border is reserved for `:focus-visible` so focus + selection stay distinct.

**Empty state (design-critic MED #1):** When filtered rows = 0, render italic serif `no memories match these filters` (same copy as Sidebar.tsx:138 for consistency) plus an inline reset button styled per mockup lines 224-229 (`transparent + 1px solid var(--accent) + 4px 12px padding + radius 3`). Click calls the existing `resetFilters()` from App.tsx.

**Keyboard nav:** arrow up/down moves row focus (`tr.focus()`), Enter calls `onMemorySelect(row.memory)`, Esc calls `onClose()`. Tab exits to next focusable (BottomBar toggle).

**Camera offset when selecting from drawer (design-critic LOW #6):** Selection from drawer should still trigger camera fly-to, but with a +drawerHeight/2 Y-offset so the selected node lands in the visible canvas region (above the 280px drawer), not behind it. Handled in LivingMap's `onMemorySelect` wrapper before forwarding to scene.

**Filters apply:** rows = `filterActive ? memories.filter(m => visibleIds.has(m.id)) : memories`.

### S2 — BottomBar drawer toggle (~0.3d) [v2: visual treatment + count + L shortcut]

**Placement (design-critic MED #3):** Last item in the **center shortcuts cluster** of BottomBar (after `click open`), NOT a 4th right region — the right-edge italic serif sentence ("size = retrievals · opacity = strength · lines = similarity") stays as the right anchor.

**Visual treatment:** Matches the existing `Kbd`-adjacent style — `<span><Kbd>L</Kbd> list ({N})</span>` form, where `{N}` is `visibleIds.size when filterActive else memoryCount` (design-critic LOW #10). The wrapping span is the click target (`cursor: pointer; hover color var(--text)`).

**Keyboard shortcut:** `L` key toggles drawer. Window keydown listener in LivingMap (gated identically to F-key: skip when target is form input or table-row). Adds `L` to BottomBar visible shortcuts.

**SR semantics:** `aria-controls="memory-drawer"` + `aria-expanded={drawerOpen}` + dynamic `aria-label="List view, ${N} memories${filterActive ? \" (filtered)\" : \"\"}"`.

### S3 — Skip-link + aria-live loading state (~0.3d) [v2: +0.1d for visual spec + aria-live]

New `ui/src/components/SkipLink.tsx`. Renders **first in LivingMap body** (not App — see S1 state-location decision), hidden off-screen by default (`position: absolute; left: -9999px`); visible only on focus.

**Visual treatment on focus (design-critic LOW #5):**
- Position: absolute, top-left of LivingMap, z-index above header
- Background: `var(--bg)` parchment
- Border: `1px solid var(--accent)` rust
- Text: `var(--accent)` rust, `var(--font-serif)`, no underline
- Padding: `8px 16px`, radius `3px`
- Contrast: rust on parchment ≈ 4.8:1, passes WCAG AA

"Skip to memory list" handler: opens drawer (`setDrawerOpen(true)`) + focuses drawer's first row.

**Loading state aria-live (eng-critic MED #6):** Update `App.tsx` loading-state div to `<div role="status" aria-live="polite">loading memories</div>` so SR users hear the load. Add a one-shot `aria-live="polite"` announcement when drawer first populates: `<span class="sr-only">N memories loaded, list view available (press L to open).</span>`.

### S4 — Canvas ARIA + role="search" + region (~0.3d) [v2: wrapper-aria-hidden + SR escape hatch]

`LivingMap.tsx` canvas wrapper:
- Outer map-frame container (the one introduced in E4) gets `role="region"` + `aria-label="Memory graph (visual representation)"`
- **Wrap the renderer container div with `aria-hidden="true"`** (eng-critic MED #4 fix) — this avoids the setAttribute timing race. Canvas is opaque to AT regardless of attribute, so aria-hidden on the wrapper covers it without imperative DOM mutation after scene construction.
- **SR escape hatch (design-critic LOW #8):** an `sr-only` `<button>` (NOT a span) reads "For a tabular alternative, view the memory list (N memories)". Click handler opens drawer + focuses first row (same as skip-link target). SR users who Tab INTO the canvas region get an actionable exit.

`Header.tsx` search input wrapper:
- `<div role="search">` around input + clear-X + match count.

### S5 — Focus rings (~0.3d)

Add a global focus-visible style block to `tokens.css`:

```css
*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

Remove any `outline: none` from existing components except where focus is
explicitly drawn via `box-shadow` (none currently).

### S6 — prefers-reduced-motion ONE-SHOT (~0.2d) [v2: dropped subscription per eng-critic HIGH #2]

**One-shot only (not subscription).** Subscribing to media query changes fights the user's manual freeze button (the "user unfreezes, OS re-emits, scene re-freezes silently" failure mode). One source of truth: `filterState.frozen`. OS preference seeds it on mount, then user controls it.

`App.tsx`:
- On mount, check `window.matchMedia('(prefers-reduced-motion: reduce)').matches`. If true, call `setFrozen(true)` once.
- **Do NOT subscribe to `addEventListener('change')`.** User can override freely after mount; if they actually want OS-preference back, they can refresh the page.

**Informational hint (design-critic MED #2):** When auto-frozen via OS, the freeze button gets `title="Frozen because your system requests reduced motion. Click to override."` AND a one-time `sr-only` span next to the button reads `Animation paused: prefers-reduced-motion enabled in OS settings.` Track origin via `frozenOrigin: 'os' | 'user' | null` state in App so the title only renders for `'os'` and reverts to standard wording when user toggles.

(scene.ts `paused` flag from E4 already handles the engine side.)

### S7 — Lighthouse pass (~0.7d) [v2: +0.2d for manualChunks BEFORE first run]

**Step 1: bundle split (eng-critic MED #5 fix).** Before first Lighthouse run, configure `vite.config.ts` `manualChunks` to vendor-split three (~600KB), d3-force, react+react-dom into separate chunks. Target chunk sizes <250KB each so HTTP/2 multiplexing helps perf.

**Step 2: run Lighthouse.**
```bash
npx lighthouse@latest http://localhost:3333 \
  --only-categories=accessibility,performance \
  --output=json \
  --output-path=docs/evals/2026-05-24-e5-lighthouse.json \
  --chrome-flags="--headless"
```
Pin version in eval doc for reproducibility.

**Step 3: capture + decide.**
- Target: a11y ≥85 (chrome regions only — canvas is exempted via aria-hidden wrapper)
- Target: perf ≥80
- Document score + per-audit findings in `docs/evals/2026-05-24-e5-lighthouse-report.md`

**Honest-shortfall protocol (design-critic LOW #9):** If perf <80 after manualChunks, **document the actual score in CHANGELOG.md** (`v0.26 ships with perf=N; v0.27 targets ≥85 via per-route splitting`) and surface it as the FIRST line of the ship-readiness-critic prompt. Do NOT silent-ship with a known acceptance miss. Per global Honest Reporting rule.

### S8 — Tests (~0.7d) [v2: +0.2d for F-key guard + integration test]

- `Drawer.test.tsx`: row rendering, click → onMemorySelect callback, arrow key nav moves focus, Enter selects, Esc closes, filter prop hides non-matching rows, empty state shows reset button + click invokes `resetFilters`.
- `SkipLink.test.tsx`: focus shows it (accent border visible), click sets drawerOpen + focuses row 0.
- `LivingMap.test.tsx`: outer wrapper has `role="region"`, inner wrapper has `aria-hidden="true"` (mock BrainScene).
- **`Drawer.integration.test.tsx` (eng-critic LOW #7):** drawer open + click row → DetailPanel opens; DetailPanel close → focus returns to drawer row; drawer close → focus returns to BottomBar toggle. **F-key guard assertion:** drawer row focused + `f` pressed → `frozen` state unchanged (eng-critic MED #3).
- **`App.fkey.test.tsx`:** existing F-key handler updated to also skip when `target.closest('table')` is non-null.

### S9 — Version bump + CHANGELOG + README (~0.3d)

- `ui/package.json`: `0.1.0` → `0.2.0`.
- `docs/CHANGELOG.md`: new entry for v0.26 UI revamp with PR refs #53-#59.
- `README.md`: refresh screenshots — `mockups/dashboard-before-parchment.png`
  (existing dark) + `mockups/dashboard-after-parchment.png` (new).

### S10 — Final ship gate

`ship-readiness-critic` then human (Keith) approval. Standard.

## Total estimate (v2 revision)

**~4.5d** across S1-S10 + critic loops. v1 estimated 3.8d; v2 +0.7d for:
- +0.3d S1 (empty state + table CSS lock-in + camera offset)
- +0.1d S3 (skip-link visual spec + aria-live loading)
- +0.2d S7 (manualChunks BEFORE first Lighthouse run)
- +0.2d S8 (integration test + F-key guard test)
- ±0d S6 (one-shot is actually simpler than subscription)

Plus +0d S4 (wrapper aria-hidden is the same effort as setAttribute, just cleaner). v0.26 roadmap memory said E5 ~2d; the drawer mirror + critic-driven fidelity pushes to 4.5d. Acceptable — drawer is the SR-accessibility win and the v2 fixes are real correctness/UX issues, not gold-plating.

## Acceptance gates

- [ ] `npm test`: all green; new tests for Drawer, SkipLink, LivingMap a11y
- [ ] `npm run build`: clean
- [ ] `node scripts/check-token-drift.mjs`: exits 0
- [ ] Manual keyboard walkthrough: Tab through chrome → reaches every
      interactive element → Enter/Space activates correctly
- [ ] Manual screen-reader walkthrough (NVDA or VoiceOver): drawer reads
      memory rows; canvas announces as "Memory graph (visual)" and skipped
- [ ] Lighthouse a11y ≥85 on chrome regions
- [ ] Lighthouse perf ≥80
- [ ] `prefers-reduced-motion: reduce` in DevTools → simulation auto-freezes
- [ ] PR #59 stacked on #58 + body documents the v0.26 close

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Lighthouse perf <80 due to 765KB bundle | If <80, add `manualChunks` for three + d3-force vendor split. If still <80, defer per-route splitting to v0.27. |
| Lighthouse a11y <85 due to canvas being audited despite aria-hidden | Configure `--skip-audits=color-contrast` for canvas region OR use Lighthouse CLI's `--throttling=cellular3G --device-emulation=mobile` to match standard CI conditions. |
| Drawer keyboard nav conflicts with global F-key freeze handler | Drawer keydown handler runs at row level (no window listener); F-key handler in App.tsx already skips when target is form input — add HTMLTableElement to the skip list. |
| Skip-link focus race on mount (drawer not yet rendered) | Drawer renders always (Option D); skip-link target exists from first paint. |
| Round-3 cap risk for plan critics | Same as E4: if both REVISE at R3, escalate to Keith with cap-hit. |

## Out of scope (deferred)

- Sortable drawer columns (mockup polish; out of v0.26 scope)
- Visual table row hover preview (DetailPanel still serves this)
- Strength mini-bar inside drawer cell (mockup line 1721-1724; visual noise at row-density)
- Smart `emptyStateSuggestion()` (mockup line 1712; detects which filter is over-constraining and offers to relax JUST that one — v0.26 uses the dumb `resetFilters` instead)
- Virtual scrolling for >1000 memories
- Snapshot/timeline/minimap (still v0.27+)
- Lighthouse perf optimisations beyond ≥80 (no service worker, no prefetch tuning, no image optimisation)
- Bundle code-split per route (single-page; not warranted)
- **E4 LOW MEDs (5 items)** from round-2/3 critic reports — AABB layout thrash caching, vestigial width/height props, shared panelTitle const, topN JSDoc drift, global collision priority. Tracked in v0.27 cleanup epic; **not blocking v0.26 ship.**

## Sign-off

Pending `plan-eng-critic` + `plan-design-critic` round 1 (then iterate to PASS).
Keith approves S1-S10 via "apply" or "S1-go" after critics clear.
