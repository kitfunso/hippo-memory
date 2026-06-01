# Plan: hippo-memory landing page (dark-premium, Astro, Cloudflare Pages)

- Date: 2026-06-01
- Episode: 01KT2EBYDBE2NV4ZEATNETP1M9 (/dev-framework-rl, project_type=ui)
- Status: Draft (NOT yet engineering/design-reviewed — judge fresh)
- Lives in: `hippo/website/` (greenfield; scaffold already green)

## Goal

A single, stunning marketing landing page for **hippo-memory** (npm OSS lib, v1.15.0,
MIT, repo `kitfunso/hippo-memory`) that converts a developer to `npm install -g
hippo-memory` + a GitHub star. Static Astro site, dark-premium aesthetic, deployed to
Cloudflare Pages. Domain is TBD by the user later (deploy to the `*.pages.dev` URL now).

## Framing (carried from brainstorm + grill)

Receipts-first conversion one-pager. Three brainstorm concerns are carried forward and
each has a home in this plan:

1. **RETRACTED-CLAIMS HAZARD (hard constraint).** hippo v1.7.9 retracted the
   sequential-learning "78% -> 14%" magnitude. A marketing page is exactly where a
   retracted number creeps back. -> See "Content: verified-only claims". The page
   carries NO sequential-learning magnitude.
2. **FUNNEL BLOAT.** -> capped at 6 content sections (+ nav/footer). See "Sections".
3. **PERFORMANCE of animations.** -> See "Performance budget" + "Motion". One small
   Preact island; everything else CSS; `prefers-reduced-motion` fully honored.

## Design system (the DESIGN spec)

Dark-premium. Violet -> cyan as the single accent gradient, glass surfaces, generous
space, one tasteful display face + a mono for the terminal.

### Color tokens (Tailwind v4 `@theme` in `global.css`)

- `--color-bg`: `#09090b` (zinc-950) base; `#0b0b10` subtle variant for section banding.
- Surface (glass): `rgba(255,255,255,0.04)` fill, `rgba(255,255,255,0.08)` border,
  `backdrop-blur`.
- Accent gradient: violet `#8b5cf6` -> cyan `#22d3ee` (used for key headline words,
  CTA, the hero glow, the decay curve stroke). Single accent only — no rainbow.
- Text: primary `#fafafa` (zinc-50), secondary `#a1a1aa` (zinc-400), muted `#71717a`.
- Terminal: bg `#0c0c0f`, prompt `#22d3ee`, success `#4ade80`, dim `#71717a`,
  text `#e4e4e7`.
- Semantic accents (sparingly): `verified` -> emerald; `error/sticks` -> rose; only as
  small inline chips to echo hippo's confidence tiers / error-memory mechanic.

### Type

- Self-hosted via `@fontsource-variable` (NO Google Fonts network call — perf + privacy,
  matches hippo's zero-network ethos):
  - Display + body: **Inter Variable** (`@fontsource-variable/inter`).
  - Mono (terminal, code, install command): **JetBrains Mono Variable**
    (`@fontsource-variable/jetbrains-mono`).
- Scale: hero `clamp(2.5rem, 6vw, 4.5rem)` / 1.05 / tight tracking; section h2
  `clamp(1.75rem,3vw,2.5rem)`; body `1.0625rem`/1.6.
- Key headline words ("forget", numbers) get the violet->cyan gradient via
  `bg-clip-text`.

### Surfaces & effects

- Container `max-w-6xl`, section padding `py-24`.
- Cards `rounded-2xl`, glass fill + 1px border, subtle inner highlight.
- Hero background: one fixed radial violet/cyan glow (low opacity) + a faint CSS dot-grid;
  no heavy images.
- Rounded corners `xl/2xl`; shadows soft and dark, never harsh.

### Motion (perf-safe)

- Terminal: a CSS/island-driven "typing" reveal of 3 commands + outputs, looping subtly
  (or play-once on view). Lightweight.
- Decay curve: the one **Preact island** — an animated SVG path that draws the
  strength-over-time decay, with a "recall" bump re-strengthening it. Triggered by
  `IntersectionObserver` (only animates when in view).
- All entrance animations: CSS `@keyframes` + `animation-timeline`/IO, short, GPU-friendly
  (transform/opacity only).
- `@media (prefers-reduced-motion: reduce)`: all animation disabled; terminal shows final
  state, curve shows final static path. Non-negotiable a11y rule.

## Sections (capped — 6 content + nav/footer)

1. **Nav** (sticky, glass on scroll): `🦛 hippo` wordmark · links: How it works ·
   Receipts · Compare · Docs(README) · GitHub (star count optional, static) · `npm i`
   pill. Mobile: condensed.
2. **Hero**: H1 "Know what to forget." + sub "A memory layer for AI agents, modeled on
   the hippocampus. Decay by default, strength through use, provenance on every memory."
   + install command block `npm install -g hippo-memory` with **copy-to-clipboard** +
   primary CTA `Star on GitHub` + secondary `Read the docs`. Right/below: the **animated
   terminal** (`hippo init --scan ~` -> `✓ memory across N repos` -> `hippo recall
   "deploy bug"` -> a ranked result with a `[verified]` chip). Install is above the fold.
3. **Problem**: "Most AI memory saves everything and searches later." The repeated-bug
   story (the agent saw the failure four times, had no way to know it should remember).
   Sets up decay/strengthen as the answer. Pulled from README "Why this exists".
4. **How it works**: buffer -> episodic -> semantic flow as 3 glass cards + the
   **animated decay-curve** centerpiece. Short labels: "Decay by default (7d half-life)",
   "Retrieval strengthens (+2d/recall)", "Sleep consolidates (3+ episodes -> 1 pattern)",
   "Errors stick (2x half-life)". Echoes README mechanics, no invented numbers.
5. **Receipts**: stat cards — `74% R@5` (LongMemEval, BM25), `926 tests` (real DB, zero
   mocks), `0 runtime deps`, `MIT`. + a "Works with" row: Claude Code, Codex, Cursor,
   OpenClaw, OpenCode, Pi, any MCP client. Each stat links to its benchmark/source. NO
   sequential-learning magnitude.
6. **Compare** (condensed): hippo's stance vs "save everything, search later" — a tight
   3-4 row highlight (Decay by default / Retrieval strengthening / Outcome-weighted /
   Zero runtime deps) framed as "one stance among several", linking to the full README
   table. NOT the 10-column table.
7. **Install / CTA**: repeat install command (copy), `hippo init --scan ~`, GitHub +
   docs + npm buttons, one line of reassurance ("Zero config. Works with every CLI agent
   you have.").
8. **Footer**: repo, npm, CHANGELOG, License MIT, "modeled on the hippocampus" line.

## Tech plan

- `src/layouts/Base.astro`: `<head>` (meta, OG/Twitter cards, canonical, font preloads,
  theme-color), global.css import, skip-link, JSON-LD SoftwareApplication.
- `src/components/`: `Nav.astro`, `Hero.astro`, `Terminal.tsx` (Preact, typing) OR
  `Terminal.astro` (CSS-only — prefer CSS if achievable), `Problem.astro`,
  `HowItWorks.astro`, `DecayCurve.tsx` (Preact island, `client:visible`), `Receipts.astro`,
  `Compare.astro`, `InstallCta.astro`, `CopyButton.tsx` (tiny island for clipboard) OR an
  inline `<script>` (prefer inline vanilla script for copy — no island needed),
  `Footer.astro`.
- Islands: minimize. Target = **1-2 islands max** (`DecayCurve` definitely; terminal +
  copy ideally CSS/vanilla `<script>`). Use `client:visible` so JS loads only on scroll.
- Content: a small `src/content/site.ts` (or inline consts) holding the verified claims
  and links — single source so copy edits don't drift. Each numeric claim has a comment
  citing README line/section.
- Tailwind v4 tokens in `global.css` via `@theme`. No `tailwind.config` needed (v4).
- SEO: title, description, OG image (a static generated/hand-made dark card — simple SVG
  -> PNG or a styled `.astro` -> screenshot; if time-boxed, a clean static OG PNG),
  sitemap optional.

## Performance budget (a11y + lighthouse)

- Lighthouse targets: **Performance >= 95, Accessibility >= 95, Best Practices >= 95,
  SEO >= 95** (mobile run).
- JS: <= ~15KB gzipped shipped (one Preact island + maybe one). Astro ships zero JS by
  default; islands are opt-in.
- Fonts: self-hosted woff2, `preload` the two critical faces, `font-display: swap`,
  subset to latin.
- CLS ~0 (reserve terminal/curve dimensions). LCP = hero text (fast).
- No layout-shifting images; decorative bg is CSS.
- a11y: semantic landmarks, one h1, heading order, focus-visible rings, AA contrast
  (body zinc-50/zinc-300 on zinc-950 passes; gradient text only on large display text +
  has an accessible solid fallback color), `prefers-reduced-motion`, copy-button has
  `aria-label` + live-region "Copied".

## Content: verified-only claims (HARD)

Sourced from `README.md` + `package.json` (audited this episode):
- v1.15.0, MIT, repo kitfunso/hippo-memory, npm `hippo-memory`, node >= 22.5.
- `74.0% R@5` LongMemEval (v0.11 BM25) / `73.8%` (v0.28 hybrid) — use "74% R@5" headline,
  footnote the split. NOT a "best published 86.8%/oracle" claim (asterisked/split-mismatched).
- `926 tests, real DB, zero mocks`. `0 runtime deps`. Works-with + imports-from lists.
- Mechanics (decay 7d, +2d/recall, errors 2x, sleep merges 3+) — all from README.
- **FORBIDDEN**: the sequential-learning 78->14% magnitude (RETRACTED v1.7.9); any
  "beats X%" leaderboard claim that the README itself asterisks as not-comparable.

## Steps (each verify-checked)

1. global.css `@theme` tokens + fonts (`@fontsource-variable/*`) -> `astro build` green.
2. Base layout + Nav + Footer -> build green, renders.
3. Hero + Terminal (CSS-first) + copy-to-clipboard -> build green; copy works.
4. Problem + HowItWorks + DecayCurve island (`client:visible`) -> build green; curve
   animates on view; reduced-motion static.
5. Receipts + Compare + InstallCta -> build green; all claims match `src/content/site.ts`.
6. SEO meta + OG + JSON-LD; responsive pass (mobile/tablet/desktop).
7. verify stage: `astro build` + lighthouse + reduced-motion + axe quick pass.

## Risks & mitigations

- **Animation perf / CLS**: dimensions reserved; transform/opacity only; IO-gated;
  reduced-motion path. Lighthouse gates it at verify.
- **Font weight**: 2 variable faces self-hosted; if perf dips, subset harder or drop to
  one face + system mono.
- **Claim drift**: single `site.ts` source + per-claim README citations; verify step
  re-checks against README.
- **Scope creep**: 6-section cap; no blog/docs-site/interactive-playground/analytics.
- **Cloudflare deploy**: static `dist/` + `wrangler pages deploy dist` (wrangler 4.61.1
  confirmed). No SSR adapter. Project-name chosen at deploy.
- **Windows/Tailwind v4**: scaffold already built green on node 24 — de-risked.

## Grill refinements (applied — /grill-me on this plan)

The plan was self-grilled; four weaknesses tightened:

1. **Island ceiling (hard).** The **decay curve is the ONLY Preact island**
   (`client:visible`). The terminal animation is CSS-only (or one tiny vanilla
   `<script>` if CSS can't carry the typing). Copy-to-clipboard is an inline vanilla
   `<script>` using `navigator.clipboard` — NOT an island. Absolute ceiling: 2 islands,
   target 1.
2. **Font/LCP.** Preload **only Inter** (the hero LCP face). JetBrains Mono loads with
   `font-display: swap`, NOT preloaded (terminal is not the LCP element). Subset to
   latin. If mobile perf dips below 95, drop mono to a system mono stack.
3. **No cherry-pick on the headline metric.** Headline `74% R@5` ONLY because that is
   the README's own headline receipt ("R@5 = 74.0%, BM25 only"); footnote the v0.28
   hybrid 73.8%. Do not invent a "best/beats" framing the README asterisks as
   not-comparable (86.8% oracle, etc.).
4. **OG image.** ONE hand-authored static `public/og.png` (1200x630, dark card +
   wordmark + tagline). No dynamic OG pipeline.

Falsifiers tracked at verify: lighthouse perf < 95 (fonts/animation) and AI-slop read
(mitigated by the specific POV + animated terminal + decay curve + real receipts; the
compare section is principle-based — hippo's decay-first stance vs "save everything,
search later" — NOT named-competitor takedowns).

## Out of scope

- Custom domain (user does later), analytics, blog, full docs site, a real in-browser
  hippo engine (the terminal is a scripted, honest re-enactment of real command output),
  dark/light toggle (dark only), i18n.
