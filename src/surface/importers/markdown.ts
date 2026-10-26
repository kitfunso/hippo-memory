import * as fs from 'node:fs';
import { type ImportResult, type TargetedImport, importEntriesInto } from './core.js';

const SLUG_MAX_CHARS = 50;

/** Slugify a heading for use as a tag.
 *  "Data Pipeline & Cache" -> "data-pipeline-cache" */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, SLUG_MAX_CHARS);
}

/**
 * Parse structured markdown into {content, sectionSlug} pairs: each heading starts a section whose
 * bullets or numbered items become memories.
 */
function parseStructuredMarkdown(raw: string): Array<{ content: string; sectionSlug: string }> {
  const results: Array<{ content: string; sectionSlug: string }> = [];
  const lines = raw.split('\n');

  let currentSlug = '';
  let pendingText = '';

  function flush(): void {
    if (!pendingText.trim()) return;
    results.push({ content: pendingText.trim(), sectionSlug: currentSlug });
    pendingText = '';
  }

  for (const line of lines) {
    const md = classifyLine(line);
    if (md.kind === 'text') {
      pendingText = pendingText ? pendingText + ' ' + md.text : md.text;
      continue;
    }
    flush();
    if (md.kind === 'heading') currentSlug = md.slug;
    else if (md.kind === 'item') pendingText = md.text;
  }

  flush();
  return results.filter((r) => r.content.length > 0);
}

/** One trimmed markdown line as the parser reads it. */
type MarkdownLine =
  | { readonly kind: 'heading'; readonly slug: string }
  | { readonly kind: 'item'; readonly text: string }
  | { readonly kind: 'blank' }
  | { readonly kind: 'text'; readonly text: string };

function classifyLine(line: string): MarkdownLine {
  const trimmed = line.trim();
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
  if (headingMatch) return { kind: 'heading', slug: slugify(headingMatch[2].trim()) };
  if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
    const text = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .trim();
    return { kind: 'item', text };
  }
  if (!trimmed) return { kind: 'blank' };
  return { kind: 'text', text: trimmed };
}

export function importMarkdownInto(filePath: string, options: TargetedImport): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseStructuredMarkdown(raw);

  // importEntries takes one tag set per call, so each section's chunks go in as one call.
  const bySlug = new Map<string, string[]>();
  for (const { content, sectionSlug } of parsed) {
    const list = bySlug.get(sectionSlug) ?? [];
    list.push(content);
    bySlug.set(sectionSlug, list);
  }

  let totalResult: ImportResult = { total: 0, imported: 0, skipped: 0, rejected: 0, entries: [] };

  for (const [slug, chunks] of bySlug.entries()) {
    const sectionTags = slug ? ['imported', slug] : ['imported'];
    const result = importEntriesInto(chunks, 'import:markdown', sectionTags, options);
    totalResult = {
      total: totalResult.total + result.total,
      imported: totalResult.imported + result.imported,
      skipped: totalResult.skipped + result.skipped,
      // rejected and redacted are optional on ImportResult, so either side may be undefined.
      rejected: (totalResult.rejected ?? 0) + (result.rejected ?? 0),
      redacted: (totalResult.redacted ?? 0) + (result.redacted ?? 0),
      entries: [...totalResult.entries, ...result.entries],
    };
  }

  return totalResult;
}
