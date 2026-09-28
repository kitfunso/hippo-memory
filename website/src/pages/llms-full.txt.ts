import type { APIRoute } from 'astro';
import { LINK } from '../content/readme-parse.mjs';
import { absoluteUrl, readmeText } from '../content/readme';

// llmstxt.org's llms-full.txt: the README as one markdown file, its repo-relative links made absolute.
export const GET: APIRoute = () =>
  new Response(readmeText.replace(LINK, (_, label: string, url: string) => `[${label}](${absoluteUrl(url)})`), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
