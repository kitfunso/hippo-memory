---
name: hippo-memory.com
direction: terminal-native, receipts-led developer marketing (2026-09-24 redesign)
updated: 2026-09-28
source_of_truth: true
tokens:
  font:
    display: "Geist"                          # h1-h3, weight 500
    sans: "Geist"                             # body
    mono: "Geist Mono"                        # code, terminal, nav, eyebrows, numbers, stats
    loading: "self-hosted via astro.config fonts: latin woff2, weights 400/500/600, display swap, metric-matched fallbacks"
  color:
    bg: "#0b0f0c"                   # ink
    accent_mint: "#7ce38b"          # recalled; token names acc-violet/acc-cyan kept, both resolve to mint
    accent_mint_light: "#a7f0b1"
    accent_amber: "#f2b84b"         # marked wrong, published losses, in-development labels
    neutrals: "zinc scale overridden in global.css with ink-tinted greys"
    text_body: "zinc-100"
    text_muted: "zinc-400"          # FLOOR for any prose on bg (7.8:1). zinc-500 is decoration only, never sentences.
    term_bg: "#0c0c12"
    term_ok: "#4ade80"
    confidence_emerald: "emerald-400"
    error_rose: "rgba(251,113,133,0.6)"  # rose-400/60 minimum; /40 fails the 3:1 non-text floor
  layout:
    container: "72rem"              # max-w-6xl. ONE container token sitewide: nav, footer, every section. No max-w-5xl wrappers.
    section_padding_y: "6rem"       # py-24 rhythm on all pages
    prose_measure: "65-75ch"        # text-sm footnotes, FAQ answers and summaries cap at max-w-lg
  type_scale:
    floor: "0.75rem"                # 12px. No text-[10px]/[11px] anywhere
    h1_leading: "1.1"               # one display leading token
    h2: "text-3xl sm:text-4xl"      # one h2 pair sitewide; h1 always a clear step above; no h2 may match another page's h1
  links:
    color: "#22d3ee"
    underline: "decoration >=40% opacity at rest"   # one treatment sitewide
  touch_targets: "44px minimum on nav pills, chips, copy buttons"
  glass:
    surface: "rgba(255,255,255,0.035) + 1px rgba(255,255,255,0.08) border + backdrop blur(14px) saturate(140%)"
    header_fallback: "rgba(10,10,15,0.85)"  # header only; verify built dist CSS retains the standard backdrop-filter property
  motion:
    reveal: "child elements only, never whole sections; fail-open (force-visible timeout) so full-page render/print/previews never blank"
    background: "fixed canvas at z-index -1, alpha <=8%, static frame under prefers-reduced-motion"
---

# hippo-memory.com design system

**2026-09-24 redesign:** Terminal Native direction. The hero shows the product (a Claude Code session with hippo's real output), receipts include published losses, and `/teams` carries the company pitch. Rules below still apply where they do not name the old violet/cyan palette.

**2026-09-28:** the hero follows the Terminal Native mockup: positioning line, h1, lead, install command and agent names on the left, the session on the right, three commands below. The brand mark on the site is the `~/hippo` wordmark in Geist Mono. The three.js Spiral is gone; `scripts/make-logo.mjs` only draws the favicon.

Codified from the shipped site plus the 2026-06-10 design audit
(C:/Users/skf_s/design-audits/hippo-memory-2026-06-10/REPORT.md). The audit's
confirmed findings are the deltas; the strengths it verified are the rules.

## Identity

Developer tool, receipts-led. The site argues with numbers (98.0% R@5, 3,500+
tests, 0 deps) and publishes its own bad results. Every page sequences:
claim, methodology, trust, reproduce. Dark-premium surface; the violet-cyan
gradient is a scalpel, not a wash.

## Hierarchy grammar

Mono uppercase eyebrow, display h2, muted body. Gradient marks exactly one
keyword per h1, always on the brand side of a comparison (hippo, never the
competitor). One primary CTA per view: the filled nav `install` button
(-> /quickstart/) is adoption, never vanity (GitHub stars sit quietly in the
nav). A page with its own primary action (/teams: the pilot) turns the nav
button to an outline. Proof lines sit under the hero install command.

## Copy rules

Numbers over adjectives. No em dashes in UI strings. No "not X, it's Y"
contrast constructions (one earned exception: "Numbers, not adjectives.").
No rhetorical scaffolding, no market-speak hedging. Footer tagline: "Good
memory is knowing what to forget: what was wrong, replaced, or never used." Forgetting
means wrong, superseded or unused, never age (ROADMAP FE4).

## Accessibility floor

AA 4.5:1 for all prose (zinc-400 minimum on bg), 3:1 for non-text glyphs.
Skip link, landmarks (labeled when repeated), one h1 per page, no skipped
heading levels, scope attrs on all comparison tables, aria-current on the
active nav item, the wordmark links home, visible focus (cyan outline), full
prefers-reduced-motion handling, 44px touch targets.

## Comparison surfaces

Homepage matrix shows 5-6 differentiator rows against 3-4 named competitors,
links to the full matrix on GitHub. Scroll containers get a right-edge fade
plus caption cue on mobile. Every comparison page ships at least one number
(the receipts strip pattern).

## Background layer

A fixed full-viewport canvas sits behind all content (z-index -1) replacing
flat #08080b: the synapse-network field (variant A) - drifting neuron dots
with depth parallax, faint links, pulses fired by scroll velocity. Luminance
stays under 8% alpha so the AA floor holds. Static single frame under
prefers-reduced-motion. Opaque section backgrounds (FAQ band) become
translucent so the field reads site-long.
