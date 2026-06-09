// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Static landing page for hippo-memory, deployed to Cloudflare Pages.
// No SSR adapter: `astro build` -> dist/ -> `wrangler pages deploy dist`.
// https://astro.build/config
export default defineConfig({
  site: 'https://hippo-memory.com',
  integrations: [preact(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
