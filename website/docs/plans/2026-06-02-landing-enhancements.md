# Plan: hippo landing page v2 enhancement suite

- Date: 2026-06-02
- Episode: 01KT403BY7VR34HW5GAFAMWH3T (/dev-framework-rl, project_type=ui)
- Status: Draft (NOT yet engineering/design-reviewed - judge fresh)
- Builds on the shipped landing page at `hippo/website/` (Astro 6 + Tailwind v4 + Preact, CF Pages)

## Goal

Raise conversion + credibility for a maturing OSS tool (679 GitHub stars, ~9.9k npm
downloads/mo) in a crowded 10-rival category, by leaning into hippo's real
differentiators: honesty, local-first/privacy, the bio model, and the UNIQUE
zero-config auto-install. Add social proof, measurement, and the missing trust/clarity
content WITHOUT bloating the hero->install funnel.

## Anti-sprawl discipline (carried from brainstorm grill)

The original page capped sections to protect the funnel. v2 adds only **3 net-new
sections**; everything else folds into existing ones:
- Architecture visual -> AUGMENTS How-it-works (not a new section)
- Social proof -> Nav star pill + a Hero stat line (not a new section)
- Cross-tool portability -> folded into the Local-first section
- Mobile nav, scroll-reveal, wordmark, SEO hygiene -> infra, no new sections

Final order: Nav -> Hero -> Problem -> How it works (+arch) -> **Get started** ->
**Local-first** -> Receipts -> Compare -> **FAQ** -> Install CTA -> Footer.
Install command appears 3x (hero above fold, Get started, final CTA).

## Items

### 1. Build-time social proof (real numbers, fetched at build)
- `src/lib/stats.ts`: `getStats()` fetches GitHub stars (`api.github.com/repos/kitfunso/
  hippo-memory`) + npm downloads (`api.npmjs.org/downloads/point/last-month/hippo-memory`)
  at BUILD time (Astro SSG frontmatter runs at build). Module-level promise cache (one
  fetch). `try/catch` + 3s timeout -> fallback to last-known constants (`stars: 679`,
  `downloads: 9858`) so the build NEVER fails offline. Format: `679` -> "679",
  `9858` -> "9.9k".
- Surface: Nav star pill ("★ 679"), Hero compact stat line ("679 stars · 9.9k downloads/mo
  · 0 deps · MIT"). HONEST LABEL: "downloads" not "installs/users" - npm counts include
  CI/mirrors/bots; the stat links to npmjs/the repo as source. NO runtime fetch, NO
  cookies. Fresh each deploy.
- Gate: numbers are meaningful (679/9.9k) so shown; if a future fetch returns 0/low,
  still shows fallback (acceptable).

### 2. Analytics (privacy-respecting, env-gated)
- Cloudflare Web Analytics beacon in `Base.astro`, gated on
  `import.meta.env.PUBLIC_CF_BEACON_TOKEN`. If unset (now), renders nothing (no-op).
  When the token is set at build (or CF dashboard toggle used instead), it activates.
  No cookies, GDPR-fine, ~0 perf. Document in a website README.

### 3. Local-first / privacy section (NEW) + portability
- Verbatim-sourced receipts: "0 outbound HTTP on the 1000-event ingestion smoke, proven
  by a `globalThis.fetch` spy that throws on call" (README L46); "your data stays on your
  machine" (SQLite on disk); "Right-to-be-forgotten is a single API call" (L57);
  multi-tenant "Tenant A literally cannot see tenant B, proven by negative test" (L58).
- Portability folded in: "Your memories shouldn't be locked in one tool" + the
  import-from chips (ChatGPT / CLAUDE.md / .cursorrules / Slack / markdown).

### 4. Get started section (NEW) = quickstart + zero-config auto-install
- 3 steps: `npm install -g hippo-memory` -> `hippo init --scan ~` -> "hippo auto-detects
  your agent framework and wires itself in; next session it just works" (README L97/L621).
- Framework chips: Claude Code, Codex, Cursor, OpenClaw, OpenCode (what gets auto-patched).
  Emphasize this is the ONLY system with auto-hook-install (per the comparison matrix).
- Copy-to-clipboard on the commands (reuse CopyCommand).

### 5. 3-layer architecture visual (augments How-it-works)
- Inline SVG: buffer -> episodic -> semantic flow, with "decay" branch to forgotten and
  "sleep: replay + merge" consolidation arrow. Matches README mermaid intent. Static SVG
  (no island), reduced-motion irrelevant (no animation, or a subtle CSS fade via reveal).

### 6. FAQ section (NEW) + FAQ JSON-LD
- ~5 Q/A handling install objections: "Is this just RAG?", "Does it need embeddings?"
  (no, BM25 default; embeddings optional), "Where does my data go?" (nowhere - local
  SQLite, 0 outbound HTTP), "Which agents work?" (auto-install list + any MCP client),
  "Is it production-ready?" (926 real-DB tests, MIT, v1.15.0). FAQPage JSON-LD in Base.

### 7. Mobile section nav
- Nav currently hides section links < md. Add a compact mobile affordance: a horizontal
  scroll-chip row of section anchors (How / Get started / Compare / FAQ) shown < md, OR a
  details/summary menu. Prefer the chip row (no JS, no overlay). Keep GitHub CTA.

### 8. Scroll-reveal animations (reduced-motion safe)
- Reuse the existing `.reveal` fade-up. Add a tiny shared inline `<script>`: IO observes
  `[data-reveal]` elements, adds `.is-visible` when in view (start hidden via a `.js`
  gate so no-JS shows everything). `prefers-reduced-motion` -> show immediately, no
  transition. Apply to section headers + cards below the fold.

### 9. SEO hygiene
- `@astrojs/sitemap` integration (site already set) -> sitemap-index.xml.
- `public/robots.txt` (allow all + sitemap URL).
- `public/apple-touch-icon.png` (180x180, rendered from the brand glyph).

### 10. Distinctive wordmark
- `Logo.astro`: inline-SVG brand glyph (the gradient rounded-square + decay-curve mark,
  matching favicon.svg for brand consistency) + "hippo" in display font. Replaces the
  bare emoji in Nav + Footer. Unifies favicon <-> logo.

### 11. README <-> page drift guard
- `scripts/check-readme-sync.mjs`: reads `../README.md` + the `comparison` data from
  `src/content/site.ts` (parsed); asserts every comparison cell string is present in the
  README comparison block (hard error on drift); warns if receipt numbers (74% R@5, 926
  tests) are absent from README. Wired into the `build` script (prebuild) and documented.
  Best-effort guard (like the graph-write lint), real source-of-truth stays the README.

## Tech / files

- NEW: `src/lib/stats.ts`, `src/components/Logo.astro`, `src/components/GetStarted.astro`,
  `src/components/LocalFirst.astro`, `src/components/Faq.astro`, `scripts/check-readme-sync.mjs`,
  `public/robots.txt`, `public/apple-touch-icon.png`, `website/README.md`.
- EDIT: `src/content/site.ts` (+getStarted, +localFirst, +faq, +stats fallback),
  `src/layouts/Base.astro` (FAQ JSON-LD, analytics beacon, apple-touch-icon),
  `src/components/Nav.astro` (logo, star pill, mobile nav), `src/components/Hero.astro`
  (stat line, logo), `src/components/HowItWorks.astro` (architecture SVG),
  `src/components/Footer.astro` (logo), `src/pages/index.astro` (new sections + reveal script),
  `astro.config.mjs` (sitemap), `package.json` (build prebuild check + @astrojs/sitemap dep).
- Islands: still ONE (DecayCurve). Everything new is .astro / CSS / inline vanilla script.

## Perf / a11y / constraints

- Lighthouse stays 100/100/100/100: build-time fetch = 0 runtime; analytics beacon is
  deferred + env-gated; SVGs inline; scroll-reveal is one tiny IO script.
- NO mobile page horizontal overflow (measure `document.scrollWidth` at 360/390); any new
  wide content (none expected) uses contained scroll.
- AA contrast on all new text (zinc-400+ on dark; emerald/amber tones already AA).
- prefers-reduced-motion honored by reveal + the existing global kill-switch.
- Verified-claims-only; every new claim sourced to a README line. No retracted magnitude.
- No library/src/schema touched. Scoped commit `website/` only (exclude strays).

## Steps (each verify-checked)

1. `src/lib/stats.ts` + site.ts content (getStarted/localFirst/faq/stats) -> build green.
2. `Logo.astro` + wire into Nav/Footer/Hero -> build green, renders.
3. Nav: star pill + mobile section-nav chips -> build green; mobile no overflow.
4. HowItWorks architecture SVG -> build green.
5. GetStarted + LocalFirst + Faq sections + index wiring -> build green; sections render.
6. Base: FAQ JSON-LD + analytics beacon (env-gated) + apple-touch-icon.
7. scroll-reveal script + [data-reveal] on below-fold blocks.
8. SEO: @astrojs/sitemap + robots.txt + apple-touch-icon.png (rendered) + website/README.md.
9. drift guard script + wire into build.
10. verify: build + drift-guard pass + lighthouse + mobile overflow (360/390) + a11y + reduced-motion.

## Risks & mitigations

- **Section sprawl** -> capped at 3 net-new; merge discipline above. Funnel: install above
  fold + 2 more install touchpoints.
- **Build-time fetch failure (offline/CI)** -> try/catch + timeout + last-known fallback;
  build never breaks.
- **Stale social-proof number** -> refreshed each deploy; fallback is recent (679/9.9k).
- **Drift guard too strict** -> hard-errors only on comparison-cell drift (verbatim copy);
  warns on claim-number changes.
- **apple-touch-icon PNG generation** -> render the glyph at 180x180 via Playwright (same
  pipeline as og.png); static artifact.
- **Analytics token absent** -> env-gated no-op; ships inert, activates on token.

## Out of scope (deferred, flagged to user)

- Real asciinema/GIF recording (needs live capture tooling + a decision on hosting).
- Custom domain (user's call; site config swap is one edit when chosen).
- Testimonials / "used by" logos (require real quotes - never fabricated).
