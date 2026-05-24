# E5 brainstorm — a11y approach for a canvas-based memory visualisation

**Episode:** `01KSDSXYT180T08V0WY73ECDHW`.
**Date:** 2026-05-24.
**Question:** What's the right accessibility story for a WebGL canvas + chrome dashboard?

## The constraint that shapes everything

The Three.js canvas is opaque to assistive technology. Screen readers see "an image" and call it a day — no node names, no positions, no semantic structure. Lighthouse can't introspect WebGL contents either; its accessibility audit only scores DOM.

So the a11y story has to work around the canvas, not through it.

## Baseline already shipped (from E2/E3/E4)

| Surface | Current state |
|---|---|
| Header search input | `aria-label="Search memories"` + clear-X with `aria-label` |
| Freeze button | `aria-pressed` + dynamic `aria-label` |
| Filter checkboxes | `aria-label` per filter |
| Strength sliders | `aria-label="Strength minimum/maximum"` |
| Age slider | `aria-label="Max age in days"` |
| Reset filters btn | `aria-label="Reset all filters"` |
| Tag cloud chips | `aria-label="Filter to tag X (N memories)"` |
| Sidebar | implicit `<aside>` + `aria-label="Filters and stats"` |
| LivingMap wrapper | `tabIndex={0}` + `onKeyDown` for Escape |
| DetailPanel | `role="dialog"` + `aria-label="Memory details"` |
| LabelOverlay | `aria-hidden="true"` (decorative) |

What's missing for a11y completeness (per plan v2 E5 acceptance):
- `role="search"` on header search region
- `role="region"` + `aria-label` on canvas wrapper; `aria-hidden="true"` on canvas itself
- Drawer mirror (offscreen `<ul>` of memory data for SR users)
- Skip-link "Skip to memory list"
- Focus rings on all interactive elements
- `prefers-reduced-motion` → `scene.setReducedMotion(true)` on mount
- Tab order audit; Enter/Arrow on filterable lists
- Lighthouse a11y ≥85 on chrome, perf ≥80

## Four candidate approaches

### Option A — Minimal ARIA + canvas hidden + use existing sidebar as SR landing

Pitch: canvas aria-hidden, SR users skip the map entirely, sidebar's stats + tag cloud + filter UI is the SR experience.

**Pros.** Cheapest (1d). Lighthouse a11y high since chrome is all real DOM. No new data surface to maintain.
**Cons.** SR user gets no memory content — they see stats and tags but can't read a single memory. The dashboard is functionally useless to them as a memory inspector.

### Option B — Offscreen drawer with visually-hidden `<ul>` of memory data

Pitch: render a CSS-hidden `<ul role="list">` containing every memory's id + content + layer + strength. Screen readers iterate it; sighted users never see it. Skip-link "Skip to memory list" jumps to the `<ul>`.

**Pros.** SR users get full data. Lighthouse passes. ~1.5d. Matches the v2 plan exactly.
**Cons.** Drawer never visible to sighted keyboard users either — they get the same canvas-opaque experience. Two data sources (canvas + offscreen list) can drift.

### Option C — Visible collapsible drawer at bottom with sortable memory table

Pitch: a "View list" button in the BottomBar opens a slide-up drawer at the bottom of the screen with a tabular memory list (id / content / layer / strength / age). Sortable columns. Keyboard navigable with arrow keys. Hides the canvas behind it when open.

**Pros.** Best a11y AND useful for sighted users (sometimes you want a list, not a map). Matches the mockup drawer pattern (lines 191-230). Single source of truth: the drawer IS the SR mirror.
**Cons.** ~2.5d. The mockup drawer has rich features (sortable, filterable, highlighted row); minimum viable is just a `<table>`.

### Option D — Hybrid: visible drawer toggle + drawer renders as ARIA-rich tabular alternative

Pitch: same drawer as C but always renders to DOM (hidden via CSS transform), so SR users see it always; sighted users toggle visibility. Drawer contents stay in sync with the FilterState so filters apply to both views.

**Pros.** Best of B + C. SR users get data without needing the toggle. ~2d.
**Cons.** Render cost (305 memories in a table even when hidden). Mitigate via virtualisation if N grows.

## Recommendation: **Option D (with C-shaped UX, B-shaped accessibility)**

- Drawer always renders the filtered memory list as a `<table>` with `role="region"` + `aria-label="Memory list view"`.
- Visible/hidden via CSS transform (not display:none, so SR still reads it).
- BottomBar gets a "list" toggle button (right-most position next to affordance key) that flips the visible state.
- Filter state from sidebar applies to drawer rows (FilterState.layers/strength/etc).
- Keyboard nav: when drawer is visible, arrow keys move row focus; Enter opens DetailPanel for that row.
- Skip-link "Skip to memory list" focuses the drawer (also opens it if hidden).

Tradeoffs accepted:
- Render cost: 305 rows is fine; for >1000 we'd add windowing (out of scope).
- The drawer drifts from the canvas visually when canvas filters apply (`scene.setFiltered`) — solved because both consume the same `visibleIds` derived from FilterState.

## Out of scope (deferred to v0.27 or later)

- Sortable drawer columns (the v2 plan E5 mentioned just keyboard nav; the mockup drawer has sortable headers as polish)
- Per-row inline actions (pin / archive / forget) — these belong in detail panel, not list view
- Virtual scrolling for >1000 memories
- Visual table styling beyond the parchment palette already locked
- Lighthouse perf optimisation beyond the ≥80 floor (no code splitting, no manual chunking — the bundle is 765KB)
- Mockup's snapshot button / timeline scrubber / minimap (still deferred)

## Picked, pending plan-design-critic + plan-eng-critic sign-off
