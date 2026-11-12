---
name: hippo-memory.com
direction: card catalogue, warm paper and typed ink (2026-11-12 revamp)
updated: 2026-11-12
source_of_truth: true
tokens:
  font:
    display: "Newsreader"                     # h1 and h2, weight 400
    sans: "Geist"                             # body, h3, buttons
    mono: "Geist Mono"                        # code, commands, figures, ids
    loading: "self-hosted via astro.config fonts: latin woff2, display swap, metric-matched fallbacks"
  color:
    paper: "#f7f4ee"                # page
    paper_2: "#fdfbf7"              # alternate bands and cards
    paper_3: "#efe9df"              # raised: inline code, the footer
    ink: "#1f1b16"                  # primary text
    ink_2: "#5e554a"                # secondary text, 6.6:1 on paper
    ink_3: "#6b6256"                # muted text, about 5.0:1 on paper-3; the floor for any sentence
    accent: "#1d5b43"               # bottle green: links, focus, the hippo row of a chart, 7.3:1 on paper
    accent_deep: "#14402f"          # primary button hover, text on an accent tint
    warn: "#a3402a"                 # published losses and "marked wrong", 5.7:1 on paper
    rule: "rgb(31 27 22 / 0.1)"     # rows, cells and section edges; never a control's only edge
    rule_strong: "rgb(31 27 22 / 0.2)"  # control borders, the agent-prompt box
  layout:
    container: "72rem"              # the `wrap` utility in global.css; every section, the nav and the footer use it
    section_padding_y: "--section-y: 4rem, 6rem from 64rem"
    prose_measure: "--measure: 34em"
  type_scale:
    floor: "0.75rem"                # 12px; no smaller text anywhere
    h1: "2.75rem, 3.25rem from sm, 3.5rem from lg on the home; 2.5rem and 3.5rem on content pages through PageIntro"
    h1_leading: "1.05"              # --leading-display
    h2: "2rem, 2.5rem from 40rem"   # set in global.css; components add no h2 size classes
    body: "1.0625rem"               # --text-body
  links:
    color: "#1d5b43"
    underline: "decoration at 35% opacity at rest, full on hover"
  buttons: "`btn` (ink fill) and `btn-quiet` (rule-strong outline) in global.css; pages add no button classes of their own"
  touch_targets: "44px minimum on nav items, copy buttons and button-styled links; a lone text link gets a 24px tap area from .tap"
  motion:
    entrance: "one .rise keyframe on the hero words; nothing reveals on scroll"
    hero_scene: "a 12-second video rendered from the three.js scene; the poster paints first; reduced motion and Save-Data keep the poster"
    durations: "--duration-fast 150ms for hover, --duration-medium 400ms, one curve --ease-standard"
---

# hippo-memory.com design system

**2026-11-12 revamp, "Card catalogue".** The owner rejected the dark lime Terminal Native site as AI slop and asked for a full revamp after a study of successful startup sites (32 home pages; the report is in the PR). The direction:

- **Product:** memory for coding agents that stops them repeating a corrected mistake, for developers and their teams.
- **Character:** calm, exact, a little warm.
- **World:** an archivist's card catalogue: oak, index cards, typed ink, one bottle-green accent.
- **Moments:** the hero cabinet, which files Monday's correction and hands it back on Tuesday, and the repeat-mistake chart.
- **Signature:** the index card with a `mem_` id, typed in Geist Mono.

The chrome stays quiet: warm paper, three ink roles, hairline rules, one accent. Colour and material live only in the moments. Removed with the old site: gradient text, glows, glass panels, the background canvas, scroll reveals, the typing terminal and uppercase tracked labels.

## Client JavaScript

- `HeroScene.astro` (about 1 KB): plays `public/hero-cabinet.mp4` (about 270 KB) over its poster `public/hero-cabinet.webp` once the hero is on screen and the browser is idle, pauses it off screen, and moves the Monday and Tuesday captions with it. Both files come from the three.js scene in `scripts/hero/cabinet.js`: run `scripts/hero/render-hero.mjs` after any change to the scene. A live WebGL scene blocked the main thread for over 2 seconds on a 4x slower phone CPU (12 Nov 2026), so three.js runs at build time only.
- `CardCabinet.astro` (an inline SVG with a small inline script, about 52 KB gzipped with its page): the card-cabinet figure beside the /how-it-works/ intro. It tours the days by itself, pauses while the reader drags it or uses the arrow keys, and holds still under reduced motion. Edit `scripts/figure/build-cabinet.mjs` and re-run it; never edit the component by hand.
- `DecayCurve.tsx`: the one Preact island, on /how-it-works/.
- `src/layouts/Base.astro`: copy buttons and the scroll-edge fade.

## Identity

Developer tool, receipts-led. The site argues with numbers and publishes its own
bad results, each linked to its source file. The home page runs: the hero and its
proofs, the problem, a real session, the test, how it works, why no model writes
memories by default, the public tests with their losses, teams, local data, who
should use something else, two FAQ answers, install.

## Hierarchy grammar

Display h2, muted body. No eyebrow above a heading, no tagline, no helper text and no secondary label: if a screen needs one to make sense, fix the layout (owner rule, 2026-11-09). Hierarchy comes from size and ink role, not weight: Newsreader at 400, Geist at 400 and 500. One primary action per view: the filled nav Install button (GitHub stars sit quietly beside it). A page with its own primary action (/teams: the pilot) turns the nav button to an outline. Under the hero sit the agents hippo works with, as one sentence, and three proof cells, each linked to the file that holds its numbers. The losses sit under the public-test table.

## Copy rules

Numbers over adjectives. No em dashes in UI strings. No "not X, it's Y"
contrast constructions (one earned exception: "Numbers, not adjectives.").
No rhetorical scaffolding, no market-speak hedging. British English with -ise endings: `check-build.mjs`
fails on the American forms listed in `scripts/us-uk.json`. Forgetting
means wrong, superseded or unused, never age (ROADMAP FE4).

## Accessibility floor

AA 4.5:1 for all prose (ink-3 is the floor), 3:1 for non-text glyphs.
Skip link, landmarks (labeled when repeated), one h1 per page, no skipped
heading levels, scope attrs on all comparison tables, aria-current on the
active nav item, the wordmark links home, visible focus (accent outline), full
prefers-reduced-motion handling, 44px touch targets. `scroll-padding-top` on
html keeps focus and anchor targets clear of the sticky header (WCAG 2.4.11), so
sections carry no `scroll-mt`. A scroll container that overflows and holds no
link joins the tab order (Base.astro), so a keyboard can scroll it. Print and
"Save as PDF" use dark ink on white with no nav chips, copy buttons or hero scene
(the `@media print` block in global.css).

## Comparison surfaces

The home page says who should use another tool and links each vs page; the full
matrix stays in the README on GitHub. Scroll containers get a right-edge fade
on mobile. Every comparison page ships at least one number
(the receipts strip pattern).

## Rules taken from Astryx (2026-11-09)

Meta's Astryx design system (github.com/meta/astryx) is the reference for these. The site
uses its rules, not its React components.
- Spacing sits on a 4px grid; the focus ring is 2px at a 3px offset.
- Motion has two durations and one curve; reduced motion stops all of it.
- A command block a reader can run as shown has a copy button. Example blocks do not.
- Every section has a stable id, so a person or an agent can link to it.
- Token names say what the token is for (`accent`, `accent-deep`, `warn`).
- `npm run build` fails on a word glued to a link, a duplicate id, a DESIGN.md colour the
  code does not use, or visible text that differs from `text-snapshot/`.
