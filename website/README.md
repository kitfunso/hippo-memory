# hippo website

Marketing landing page for [hippo-memory](https://github.com/kitfunso/hippo-memory).
Static Astro 6 + Tailwind v4 + one Preact island, deployed to Cloudflare Pages.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # drift-guard + astro build -> dist/
npm run preview  # serve the built dist/
```

## Deploy (Cloudflare Pages)

```bash
npm run deploy   # build + wrangler pages deploy dist
```

Production: https://hippo-memory.com (apex custom domain on Cloudflare Pages). The
hippo-memory.pages.dev subdomain still serves the same deployment; canonical tags point
to the apex.

## Notes

- **Social proof** (`src/lib/stats.ts`): GitHub stars + npm downloads are fetched at
  BUILD time and baked into the static HTML (no runtime fetch, no cookies). On a failed
  fetch it falls back to last-known constants and logs a warning, so the build never
  breaks. Numbers are as-of the last deploy - redeploy to refresh.
- **Analytics**: Cloudflare Web Analytics is wired in `src/layouts/Base.astro`, gated on
  `PUBLIC_CF_BEACON_TOKEN`. To enable, either set that env var at build
  (`PUBLIC_CF_BEACON_TOKEN=... npm run build`) OR just flip on Web Analytics in the CF
  Pages dashboard (edge-injected, zero code - the simpler path). No cookies.
- **Content** lives in `src/content/site.ts`. Every claim is sourced to the README;
  the sequential-learning magnitude retracted in README v1.7.9 is deliberately absent.
- **Drift guard** (`scripts/check-readme-sync.mjs`, run by `npm run build`): fails the
  build if the comparison matrix in `site.ts` drifts from the README's #comparison table.
  The README is the source of truth - edit both together.
- **One Preact island** only (`DecayCurve.tsx`, `client:visible`); everything else is
  static `.astro` + CSS + small inline scripts.
