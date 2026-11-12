// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { pageDate } from './src/lib/page-dates.mjs';

// Static landing page for hippo-memory, deployed to Cloudflare Pages.
// No SSR adapter: `astro build` -> dist/ -> `wrangler pages deploy dist`.
// https://astro.build/config
export default defineConfig({
  site: 'https://hippo-memory.com',
  // Astro 7's 'jsx' default glues a word to an inline tag that starts on the next source line.
  compressHTML: true,
  integrations: [preact(), sitemap({ serialize: (item) => ({ ...item, lastmod: pageDate(new URL(item.url).pathname) }) })],
  // Self-hosted Newsreader and Geist: latin only, one file per weight in use, metric-matched fallbacks.
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'Newsreader',
      cssVariable: '--font-newsreader',
      fallbacks: ['Georgia', 'serif'],
      options: {
        variants: [
          { weight: 400, style: 'normal', src: ['@fontsource/newsreader/files/newsreader-latin-400-normal.woff2'] },
        ],
      },
    },
    {
      provider: fontProviders.local(),
      name: 'Geist',
      cssVariable: '--font-geist',
      options: {
        variants: [
          { weight: 400, style: 'normal', src: ['@fontsource/geist/files/geist-latin-400-normal.woff2'] },
          { weight: 500, style: 'normal', src: ['@fontsource/geist/files/geist-latin-500-normal.woff2'] },
          { weight: 600, style: 'normal', src: ['@fontsource/geist/files/geist-latin-600-normal.woff2'] },
        ],
      },
    },
    {
      provider: fontProviders.local(),
      name: 'Geist Mono',
      cssVariable: '--font-geist-mono',
      fallbacks: ['monospace'],
      options: {
        variants: [
          { weight: 400, style: 'normal', src: ['@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2'] },
          { weight: 500, style: 'normal', src: ['@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2'] },
          { weight: 600, style: 'normal', src: ['@fontsource/geist-mono/files/geist-mono-latin-600-normal.woff2'] },
        ],
      },
    },
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
