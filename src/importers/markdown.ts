import * as fs from 'fs';
import { type ImportResult, type ImportOptions, importEntries } from './core.js';

// ---------------------------------------------------------------------------
// Structured markdown importer (MEMORY.md / AGENTS.md format)
// ---------------------------------------------------------------------------

/**
 * Slugify a heading for use as a tag.
 * "Data Pipeline & Cache" -> "data-pipeline-cache"
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

/**
 * Parse structured markdown into {content, sectionSlug} pairs.
 * Each heading starts a new section. Bullet points / numbered items under
 * the heading become individual memories tagged with the section slug.
 */
function parseStructuredMarkdown(raw: string): Array<{ content: string; sectionSlug: string }> {
  const results: Array<{ content: string; sectionSlug: string }> = [];
  const lines = raw.split('\n');

  let currentSection = '';
  let currentSlug = '';
  let pendingText = '';

  function flush(): void {
    if (!pendingText.trim()) return;
    results.push({ content: pendingText.trim(), sectionSlug: currentSlug });
    pendingText = '';
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flush();
      currentSection = headingMatch[2].trim();
      currentSlug = slugify(currentSection);
      continue;
    }

    // Bullet or numbered item: flush previous, start new
    if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flush();
      const itemText = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      pendingText = itemText;
      continue;
    }

    // Empty line: flush current pending
    if (!trimmed) {
      flush();
      continue;
    }

    // Continuation of current item
    pendingText = pendingText ? pendingText + ' ' + trimmed : trimmed;
  }

  flush();
  return results.filter((r) => r.content.length > 0);
}

export function importMarkdown(filePath: string, options: ImportOptions): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseStructuredMarkdown(raw);

  // Group by section slug so we can pass per-chunk tags
  // We call importEntries per unique slug to get the right tags per section
  const bySlug = new Map<string, string[]>();
  for (const { content, sectionSlug } of parsed) {
    const list = bySlug.get(sectionSlug) ?? [];
    list.push(content);
    bySlug.set(sectionSlug, list);
  }

  let totalResult: ImportResult = { total: 0, imported: 0, skipped: 0, rejected: 0, entries: [] };

  for (const [slug, chunks] of bySlug.entries()) {
    const sectionTags = slug ? ['imported', slug] : ['imported'];
    const result = importEntries(chunks, 'import:markdown', sectionTags, options);
    totalResult = {
      total: totalResult.total + result.total,
      imported: totalResult.imported + result.imported,
      skipped: totalResult.skipped + result.skipped,
      // AT1 P2 fix: `rejected` is now optional on ImportResult (compat) — tolerate
      // undefined on either side of the accumulation.
      rejected: (totalResult.rejected ?? 0) + (result.rejected ?? 0),
      redacted: (totalResult.redacted ?? 0) + (result.redacted ?? 0),
      entries: [...totalResult.entries, ...result.entries],
    };
  }

  return totalResult;
}
