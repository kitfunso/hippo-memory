/**
 * Memory importers for Hippo.
 * Imports memories from ChatGPT, Claude, Cursor, generic files, and structured markdown.
 */

import * as fs from 'fs';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import { initStore, loadAllEntries, writeEntry } from './store.js';
import { textOverlap } from './search.js';
import { getGlobalRoot, initGlobal } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  total: number;     // entries found in source
  imported: number;  // actually imported (after dedup)
  skipped: number;   // skipped as duplicates or too short
  entries: MemoryEntry[];
}

export interface ImportOptions {
  dryRun?: boolean;
  global?: boolean;
  extraTags?: string[];
  hippoRoot: string;
}

// ---------------------------------------------------------------------------
// Shared core: dedup + write
// ---------------------------------------------------------------------------

/**
 * Given an array of raw text chunks, deduplicate against existing memories,
 * create MemoryEntry objects, write them (unless dry-run), and return a result.
 */
export function importEntries(
  chunks: string[],
  source: string,
  tags: string[],
  options: ImportOptions
): ImportResult {
  const targetRoot = options.global ? getGlobalRoot() : options.hippoRoot;

  // Ensure store is ready
  if (options.global) {
    initGlobal();
  }

  const existing = loadAllEntries(targetRoot);
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];

  let total = 0;
  let imported = 0;
  let skipped = 0;
  const entries: MemoryEntry[] = [];

  for (const raw of chunks) {
    const trimmed = raw.trim();
    if (trimmed.length > 1000) {
      console.error(`Warning: imported memory truncated from ${trimmed.length} to 1000 chars`);
    }
    const chunk = trimmed.slice(0, 1000);

    // Skip empty or too-short chunks
    if (!chunk || chunk.length < 10) {
      skipped++;
      continue;
    }

    total++;

    // Dedup check: textOverlap > 0.7 with any existing memory = skip
    let isDuplicate = false;
    for (const existing_entry of existing) {
      if (textOverlap(chunk, existing_entry.content) > 0.7) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      skipped++;
      continue;
    }

    // A3: kind defaults to 'distilled'. ChatGPT/Claude/Cursor exports are curated
    // user pastes, not raw transcripts from a system of record, so distilled is
    // correct here. When E1.x ingestion connectors land (Slack/Jira/Gmail webhooks),
    // they MUST set kind: 'raw' explicitly and route deletions through
    // archiveRawMemory(). See MEMORY_ENVELOPE.md.
    const entry = createMemory(chunk, {
      layer: Layer.Episodic,
      tags: allTags,
      source,
      confidence: 'observed',
    });

    entries.push(entry);

    if (!options.dryRun) {
      writeEntry(targetRoot, entry);
      // Add to existing so subsequent chunks dedup against freshly imported ones
      existing.push(entry);
    }

    imported++;
  }

  return { total, imported, skipped, entries };
}

// ---------------------------------------------------------------------------
// ChatGPT importer
// ---------------------------------------------------------------------------

/**
 * Parse ChatGPT memory export file.
 * Supports:
 *   - JSON array of strings: ["memory 1", "memory 2"]
 *   - JSON array of objects: [{"content": "...", "created": "..."}]
 *   - ChatGPT export format: {"memories": [{"content": "...", "created_at": "..."}]}
 *   - Plain text: one memory per line
 */
function parseChatGPTFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  // Try JSON first
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);

      // {"memories": [...]} - ChatGPT export format
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.memories)) {
        return parsed.memories
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }

      // Array format
      if (Array.isArray(parsed)) {
        return parsed
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to plain text
    }
  }

  // Plain text: one memory per line
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importChatGPT(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseChatGPTFile(filePath);
  return importEntries(chunks, 'import:chatgpt', ['imported', 'chatgpt'], options);
}

// ---------------------------------------------------------------------------
// Claude importer
// ---------------------------------------------------------------------------

const HIPPO_START = '<!-- hippo:start -->';
const HIPPO_END = '<!-- hippo:end -->';

/**
 * Strip the hippo hook block from markdown content.
 */
function stripHippoBlock(content: string): string {
  const startIdx = content.indexOf(HIPPO_START);
  const endIdx = content.indexOf(HIPPO_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + HIPPO_END.length);
}

/**
 * Split markdown into meaningful chunks (headings + bullet points).
 */
function splitMarkdown(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Heading: start a new chunk
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (current.trim()) chunks.push(current.trim());
      current = trimmed;
      continue;
    }

    // Bullet point: each bullet is its own chunk (flush previous if not a bullet context)
    if (/^[-*+]\s+/.test(trimmed)) {
      if (current.trim() && !/^[-*+]\s+/.test(current.split('\n')[0])) {
        chunks.push(current.trim());
        current = '';
      }
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^[-*+]\s+/, '').trim();
      continue;
    }

    // Numbered list item
    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    // Empty line
    if (!trimmed) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    // Regular line: append to current
    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

/**
 * Parse CLAUDE.md or Claude memory.json.
 */
function parseClaudeFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');

  // JSON memory file
  if (filePath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to markdown
    }
  }

  // Markdown file: strip hippo block and split
  const cleaned = stripHippoBlock(raw);
  return splitMarkdown(cleaned);
}

export function importClaude(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseClaudeFile(filePath);
  return importEntries(chunks, 'import:claude', ['imported', 'claude'], options);
}

// ---------------------------------------------------------------------------
// Cursor importer
// ---------------------------------------------------------------------------

/**
 * Split cursor rules file into chunks.
 * Priority: numbered items, then bullet points, then double newlines.
 */
function parseCursorFile(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comment-only lines that are empty after stripping #
    if (!trimmed || trimmed === '#') {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    // Numbered item: 1. 2. 3.
    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    // Bullet: - or *
    if (/^[-*]\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^[-*]\s+/, '').trim();
      continue;
    }

    // Regular line
    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());

  // Also split on double newlines within chunks if they somehow ended up there
  return chunks.flatMap((c) => {
    const parts = c.split(/\n{2,}/);
    return parts.map((p) => p.trim()).filter(Boolean);
  });
}

export function importCursor(filePath: string, options: ImportOptions): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = parseCursorFile(raw);
  return importEntries(chunks, 'import:cursor', ['imported', 'cursor'], options);
}

// ---------------------------------------------------------------------------
// Generic file importer
// ---------------------------------------------------------------------------

/**
 * Split a generic file into chunks.
 * Markdown: split on headings and bullet points.
 * Plain text: split on double newlines or one-per-line.
 */
function parseGenericFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');

  if (isMarkdown) {
    return splitMarkdown(raw);
  }

  // Plain text: try double newlines first
  const byParagraph = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;

  // Fall back to one-per-line
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importGenericFile(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseGenericFile(filePath);
  return importEntries(chunks, 'import:file', ['imported'], options);
}

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

  let totalResult: ImportResult = { total: 0, imported: 0, skipped: 0, entries: [] };

  for (const [slug, chunks] of bySlug.entries()) {
    const sectionTags = slug ? ['imported', slug] : ['imported'];
    const result = importEntries(chunks, 'import:markdown', sectionTags, options);
    totalResult = {
      total: totalResult.total + result.total,
      imported: totalResult.imported + result.imported,
      skipped: totalResult.skipped + result.skipped,
      entries: [...totalResult.entries, ...result.entries],
    };
  }

  return totalResult;
}
