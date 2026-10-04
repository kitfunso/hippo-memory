# Hippo dashboard design system

## Identity

A calm instrument for reading memory health. Light surfaces, one blue accent, one orange for risk, IBM Plex type. The mockup `designs/dashboard-revamp-20261003/B-ledger-2d.html` is the visual spec; `ui/src/tokens.css` and `ui/src/views/Health/health.css` are its port.

## Words

Health view (never "Ledger"), Global, Unassigned, at-risk memory, origin project, Board, card.

## Tokens

All tokens live in `ui/src/tokens.css` at `:root`. A test (T10) fails when any custom property used under `ui/src` has no definition.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#f3f5f8` | page background |
| `--surface` | `#fff` | cards, header, panels |
| `--line` | `#e1e5eb` | hairlines, card borders |
| `--line-2` | `#cbd2db` | stronger borders, frames |
| `--text` | `#111827` | primary text |
| `--text-2` | `#3f4856` | secondary text |
| `--text-3` | `#5b6574` | labels, hints (4.5:1 on `--bg`) |
| `--accent` | `#2f6fed` | focus, selection, primary action |
| `--accent-ink` | `#1f55c9` | accent text on light fills |
| `--accent-weak` | `#eaf1fe` | selected row, chip fill |
| `--risk` | `#b5451b` | at-risk text and errors |
| `--risk-weak` | `#fff1e8` | at-risk fill |
| `--sans` | IBM Plex Sans | body and UI |
| `--mono` | IBM Plex Mono | ids, numbers, code |

### Old to new

The dark "brain observatory" tokens are gone. Nothing aliases them.

| Old | New |
| --- | --- |
| `--glass-bg`, `--glass-bg-strong`, `--map-bg` | `--surface` |
| `--glass-border`, `--border` | `--line` (frames: `--line-2`) |
| `--dim`, `--text-faint`, `--ink-faint` (as text) | `--text-3` |
| `--ink-faint` (as fill) | `--bg` |
| `--text` | `--text` (value changed) |
| `--accent` | `--accent` (violet to blue) |
| `--accent-focus` | `--accent-weak` |
| `--red` | `--risk` |
| `--font-serif`, `--font-body` | `--sans` |
| `--font-mono` | `--mono` |

## Type

Fonts are bundled from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (latin 400, 500, 600) and imported in `main.tsx`; the page makes no request to a font host. Numbers use tabular figures. The smallest text is 12px.

## Colour in the treemap

Cells are the strength bands of a project: pinned, strong, fading, at risk. The wire carries counts per band, not each memory's strength, so a band has a fixed tint. Colours and names are in `views/Health/canvas/riskColor.ts`. At-risk share uses a sequential ramp, never red against green, and the legend names every step.

## Layout

- Header 64px: crumbs, search, range, view switch, Updated label, Refresh. Phone width (`max-width: 760px`) wraps it into two rows.
- Health overview: KPI strip, then a map card (Map or Table) with a rail beside it. Below 1240px the rail narrows to 232px; at phone width it drops under the map.
- Board: a 44px toolbar, then one column per status. A card opens a side panel; on phones it is a modal bottom sheet.
- `main` holds one view at a time. Its first child is the `h1` (screen-reader only on the overview).

## Interaction

- Hash routes: `#/`, `#/p/<key>`, `#/p/<key>/m/<id>`, `#/board`.
- One Refresh per view, none on the Board header. It rebuilds the snapshot once; other panels follow the new `snapshotId`.
- The tab refetches the overview when it becomes visible and the data is over 30 s old.
- Search waits 200 ms, aborts the previous request and shows "Searching" until the answer for the typed query arrives.
- Treemap touch: `touch-action: pan-y`, pinch to zoom, taps ignored for 350 ms after a pinch, first tap shows a closable tip, second tap opens.
- Reduced motion turns every tween and transition off.

## Accessibility

- The treemap has a keyboard twin: the Table toggle shows the same numbers in a grid with `aria-rowcount` and `aria-rowindex`.
- Every state has text: loading (`role="status"`), error (`role="alert"` with Retry), empty store.
- Focus ring is a 2px `--accent` outline.
- Touch targets are 44px on phones.
