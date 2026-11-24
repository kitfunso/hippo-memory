import type { APIRoute } from 'astro';
import { LINK } from '../content/readme-parse.mjs';
import { absoluteUrl, readmeText } from '../content/readme';

export const GET: APIRoute = () =>
  new Response(readmeText.replace(LINK, (_, label: string, url: string) => `[${label}](${absoluteUrl(url)})`), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
