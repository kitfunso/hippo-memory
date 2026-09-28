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

## Images

`scripts/make-images.mjs` draws the favicon, the apple-touch icon and one 1200x630 Open
Graph card per page (`public/og/<slug>.png`, captioned with the page's `<title>`). It
reads the built pages, so after adding a page or changing a title run `npm run build`,
then `node scripts/make-images.mjs`, then `npm run build` again so the page links its own
card; a page without one uses `/og/home.png`. It needs Chrome (`CHROME=<path>` if Chrome
is not in its default place). `--social <file.png>` also draws the 1280x640 GitHub social
preview, which is uploaded by hand in the repo settings.

## Deploy (Cloudflare Pages)

```bash
npm run deploy   # build + wrangler pages deploy dist
```

Production: https://hippo-memory.com (apex custom domain on Cloudflare Pages). The
hippo-memory.pages.dev subdomain still serves the same deployment; canonical tags point
to the apex.

After a production deploy is live, submit the changed URLs to IndexNow. The search
engines fetch the key file (`public/<key>.txt`) from the site, so never run it before the
deploy.

```bash
node scripts/indexnow.mjs --dry-run   # print the payload, send nothing
node scripts/indexnow.mjs             # every URL in dist/sitemap-0.xml
node scripts/indexnow.mjs https://hippo-memory.com/faq/   # only the URLs given
```

## Notes

- **Social proof** (`src/lib/stats.ts`): GitHub stars + npm downloads are fetched at
  BUILD time and baked into the static HTML (no runtime fetch, no cookies). On a failed
  fetch it falls back to last-known constants and logs a warning, so the build never
  breaks. Numbers are as-of the last deploy - redeploy to refresh.
- **Analytics**: Cloudflare Web Analytics is wired in `src/layouts/Base.astro`, gated on
  `PUBLIC_CF_BEACON_TOKEN`. To enable, either set that env var at build
  (`PUBLIC_CF_BEACON_TOKEN=... npm run build`) OR just flip on Web Analytics in the CF
  Pages dashboard (edge-injected, zero code - the simpler path). No cookies.
- **Content**: hand-written copy lives in `src/content/site.ts` and the pages. The
  comparison table and the FAQ are parsed out of the root `README.md` at build
  (`src/content/readme.ts`), so edit them there. Every claim is sourced to the README;
  the sequential-learning magnitude retracted in README v1.7.9 is deliberately absent.
- **For AI assistants**: `public/llms.txt` is the llmstxt.org index of the site and repo;
  `/llms-full.txt` serves the README itself, with its links made absolute.
- **Drift guard** (`scripts/check-readme-sync.mjs`, run by `npm run build` and by CI on
  every PR): fails if the README's comparison table or FAQ stops parsing, if an FAQ answer
  would carry markdown into its plain-text JSON-LD, or if hand-written copy (the test
  count, the LoCoMo rows, the hero proofs) drifts from the README. The README is the
  source of truth.
- **One Preact island** only (`DecayCurve.tsx`, `client:visible`); everything else is
  static `.astro` + CSS + small inline scripts.
