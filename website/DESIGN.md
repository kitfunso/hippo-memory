---
name: hippo-memory.com
direction: dark-premium, receipts-led developer marketing
updated: 2026-06-10
source_of_truth: true
tokens:
  font:
    display: "Bricolage Grotesque Variable"   # h1-h3 only
    sans: "Hanken Grotesk Variable"           # body
    mono: "JetBrains Mono Variable"           # code, numbers, eyebrows, stats
  color:
    bg: "#08080b"
    accent_violet: "#a78bfa"
    accent_cyan: "#22d3ee"
    gradient: "linear-gradient(110deg, #a78bfa 0%, #22d3ee 100%)"  # surgical: one headline keyword, CTA ring, decay curve. Never a background fill.
    gradient_fallback: "#c4b5fd"
    text_body: "zinc-100"
    text_muted: "zinc-400"          # FLOOR for any prose on bg (7.8:1). zinc-500 is decoration only, never sentences.
    term_bg: "#0c0c12"
    term_ok: "#4ade80"
    confidence_emerald: "emerald-400"
    error_rose: "rgba(251,113,133,0.6)"  # rose-400/60 minimum; /40 fails the 3:1 non-text floor
  layout:
    container: "72rem"              # max-w-6xl. ONE container token sitewide: nav, footer, every section. No max-w-5xl wrappers.
    section_padding_y: "6rem"       # py-24 rhythm on all pages
    prose_measure: "65-75ch"        # cap footnotes/summaries at max-w-2xl
  type_scale:
    floor: "0.75rem"                # 12px. No text-[10px]/[11px] anywhere
    h1_leading: "1.03"              # one display leading token
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

Codified from the shipped site plus the 2026-06-10 design audit
(C:/Users/skf_s/design-audits/hippo-memory-2026-06-10/REPORT.md). The audit's
confirmed findings are the deltas; the strengths it verified are the rules.

## Identity

Developer tool, receipts-led. The site argues with numbers (98.6% R@5, 926
tests, 0 deps) and publishes its own bad results. Every page sequences:
claim, methodology, trust, reproduce. Dark-premium surface; the violet-cyan
gradient is a scalpel, not a wash.

## Hierarchy grammar

Mono uppercase eyebrow, display h2, muted body. Gradient marks exactly one
keyword per h1, always on the brand side of a comparison (hippo, never the
competitor). Primary CTA above the fold is adoption ("Get started" ->
/quickstart/), never vanity (GitHub stars live in the nav badge). One proof
line under the hero subhead.

## Copy rules

Numbers over adjectives. No em dashes in UI strings. No "not X, it's Y"
contrast constructions (one earned exception: "Numbers, not adjectives.").
No rhetorical scaffolding, no market-speak hedging. Footer tagline: "Good
memory is knowing what to forget."

## Accessibility floor

AA 4.5:1 for all prose (zinc-400 minimum on bg), 3:1 for non-text glyphs.
Skip link, landmarks (labeled when repeated), one h1 per page, no skipped
heading levels, scope attrs on all comparison tables, aria-current on the
active nav item, logo links home, visible focus (cyan outline), full
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
