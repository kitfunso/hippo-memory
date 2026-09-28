// README.md is the source of truth for the comparison table and the FAQ; parsing both at build time
// means the site cannot drift from it, and a parse that finds nothing fails the build.
import raw from '../../../README.md?raw';
import { LINK, REPO, mdText, parseComparison, parseFaq, unescapeMd } from './readme-parse.mjs';

export { REPO, mdText };

export const readmeText = raw.replace(/\r\n/g, '\n');
export const readmeComparison = parseComparison(readmeText);
export const readmeFaq = parseFaq(readmeText);

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// README links are relative to the repo; off GitHub they must point back at it.
export function absoluteUrl(url: string): string {
  if (/^(https?:|mailto:)/.test(url)) return url;
  if (url.startsWith('#')) return `${REPO}${url}`;
  return `${REPO}/blob/master/${url.replace(/^\.\//, '')}`;
}

// `anchors` sends README anchors to site pages (e.g. '#mcp-server' -> '/mcp/'); other links open in a new tab.
export function mdInline(md: string, anchors: Record<string, string> = {}): string {
  const code: string[] = [];
  const text = md.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`);
  return escHtml(unescapeMd(text))
    .replace(LINK, (_, label: string, url: string) => {
      const local = anchors[url];
      if (local) return `<a class="link" href="${local}">${label}</a>`;
      return `<a class="link" href="${absoluteUrl(url)}" target="_blank" rel="noopener noreferrer">${label}<span class="sr-only"> (opens in new tab)</span></a>`;
    })
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escHtml(code[Number(i)])}</code>`);
}

// README anchors that have a page of their own on the site.
const siteAnchors: Record<string, string> = { '#mcp-server': '/mcp/' };

/** A README answer as HTML paragraphs, one per blank-line-separated block. */
export const mdParagraphs = (md: string): string[] => md.split(/\n{2,}/).map((p) => mdInline(p, siteAnchors));

/** FAQPage JSON-LD for items that are also visible on the page (Google's rule), with plain-text answers. */
export const faqPageLd = (items: ReadonlyArray<{ q: string; a: string }>) => ({
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: mdText(f.a) },
  })),
});
