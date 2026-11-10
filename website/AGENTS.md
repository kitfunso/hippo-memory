# hippo website: rules for agents

Static Astro + Tailwind v4, deployed to Cloudflare Pages as hippo-memory.com. `DESIGN.md` holds
the design rules and `README.md` the dev and deploy commands. Read both before a change.

## Rules

- **Wording is locked.** A layout, docs or accuracy task changes no visible text. A text change
  needs the owner's ask. `npm run build` compares each page with `text-snapshot/` and fails on a
  difference. When the owner asked for the change, run `npm run snapshot` and commit the result.
- **No eyebrow, tagline, helper text or secondary label.** If a screen needs one to make sense,
  fix the layout.
- **The README is the source** for the comparison table and the FAQ. Edit them there, never here.
- **No new client JavaScript** without a line in `DESIGN.md` that says why. The site ships one
  Preact island, the layout script (copy, scroll fade, reveal), the hero typing script and the
  background canvas script.
- **Tokens** live in `src/styles/global.css`: `accent`, `accent-light`, `warn`, the tinted `zinc`
  scale, `--duration-fast`, `--duration-medium`, `--ease-standard`, `--leading-display`,
  `--measure`, `--section-y`. Use them; do not write a hex or a duration in a component.
  Two files draw outside CSS and carry their own hexes: `src/components/DecayCurve.tsx` and
  `scripts/make-images.mjs`. Change them with the token.
- **A copy button** goes only on a command block a reader can run as shown (`<Cmd copy>`).
  Example blocks get none.

## Components (`src/components`)

- `Nav`, `Footer`, `BackgroundFx`: on every page. `Nav` reads build-time stats from `src/lib/stats.ts`.
- `PageIntro`: the h1 and lead of a content page. `Section`: one titled block; its id is the
  slug of its title (`src/lib/slug.ts`).
- `Cmd`: a terminal or config block. `CopyCommand`: one command in a row with a copy button.
  `CopyButton`: the button both use; the click handler is in `src/layouts/Base.astro`.
- `VsTable`: hippo against one system, from the README table. `Faq`: a pick of README answers.
- `RepeatMistakes`: the Z0 round 3 card. `DecayCurve.tsx`: the only Preact island.
- Home only: `Hero`, `Terminal`, `Problem`, `HowItWorks`, `GetStarted`, `LocalFirst`, `Receipts`,
  `Compare`, `InstallCta`.

## Checks before a PR

```bash
npm --prefix website ci
npm --prefix website run build   # README guard, astro build, then scripts/check-build.mjs
```

`check-build.mjs` fails on a word glued to a link or inline code, a duplicate id, a `DESIGN.md`
colour the code does not use, and visible text that differs from `text-snapshot/`. After a
deploy, run Lighthouse on the changed pages: every page scores 100 in each category today.
