/**
 * Import memories from external sources.
 *
 * Supported formats:
 *   --chatgpt <file>   ChatGPT memories.json or plain text
 *   --claude <file>    CLAUDE.md (skips hippo:start/end blocks)
 *   --cursor <file>    .cursorrules
 *   --file <file>      Generic one-memory-per-line
 *   --markdown <file>  Structured markdown with heading hierarchy as tags
 */

import * as fs from 'fs';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import {
  getHippoRoot,
  isInitialized,
  initStore,
  writeEntry,
  loadAllEntries,
  updateStats,
} from './store.js';
import { getGlobalRoot, initGlobal } from './shared.js';
import { isEmbeddingAvailable, embedMemory } from './embeddings.js';

// ---------------------------------------------------------------------------
// Normalisation for deduplication
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate(content: string, existing: MemoryEntry[]): boolean {
  const norm = normalise(content);
  if (!norm) return true; // empty content counts as duplicate
  for (const e of existing) {
    if (normalise(e.content) === norm) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse ChatGPT memories.json or plain text file. */
export function parseChatGPT(raw: string): string[] {
  const trimmed = raw.trim();

  // Try JSON first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .map((item: unknown) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object' && 'content' in item) {
            return String((item as Record<string, unknown>).content).trim();
          }
          return '';
        })
        .filter((s: string) => s.length > 0);
    } catch {
      // Fall through to line-based parsing
    }
  }

  // Plain text: one memory per line
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Parse CLAUDE.md, extracting bullet points and sections. Skips hippo blocks. */
export function parseClaude(raw: string): string[] {
  // Remove <!-- hippo:start -->...<!-- hippo:end --> blocks
  const cleaned = raw.replace(
    /<!--\s*hippo:start\s*-->[\s\S]*?<!--\s*hippo:end\s*-->/g,
    ''
  );

  const memories: string[] = [];
  const lines = cleaned.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings, empty lines, code fences, HTML comments
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('<!--')) continue;
    if (trimmed.startsWith('---')) continue;

    // Extract bullet point content (-, *, numbered)
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+\.\s+(.+)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content.length > 3) {
        memories.push(content);
      }
      continue;
    }

    // Plain text paragraphs (non-bullet, non-heading lines that have substance)
    if (trimmed.length > 10 && !trimmed.startsWith('|')) {
      memories.push(trimmed);
    }
  }

  return memories;
}

/** Parse .cursorrules, splitting rules into individual memories. */
export function parseCursor(raw: string): string[] {
  const memories: string[] = [];
  const lines = raw.split('\n');

  // Collect multi-line rules separated by blank lines or comment headers
  let currentRule: string[] = [];

  const flushRule = (): void => {
    const text = currentRule
      .map((l) => l.replace(/^#\s*/, '').trim())
      .filter((l) => l.length > 0)
      .join(' ')
      .trim();
    if (text.length > 5) {
      memories.push(text);
    }
    currentRule = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      // Blank line: flush the current rule
      if (currentRule.length > 0) flushRule();
      continue;
    }

    // Bullet points are individual rules
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      if (currentRule.length > 0) flushRule();
      const content = bulletMatch[1].trim();
      if (content.length > 3) {
        memories.push(content);
      }
      continue;
    }

    // Numbered rules
    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      if (currentRule.length > 0) flushRule();
      const content = numMatch[1].trim();
      if (content.length > 3) {
        memories.push(content);
      }
      continue;
    }

    currentRule.push(trimmed);
  }

  if (currentRule.length > 0) flushRule();

  return memories;
}

/** Parse generic file: one memory per non-empty line. */
export function parseFile(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Slugify a heading for use as a tag. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Parse structured markdown preserving heading hierarchy as tags. */
export function parseMarkdown(raw: string): Array<{ content: string; tags: string[] }> {
  const results: Array<{ content: string; tags: string[] }> = [];
  const lines = raw.split('\n');

  // Track current heading hierarchy
  const headingStack: Array<{ level: number; tag: string }> = [];

  const getCurrentTags = (): string[] => headingStack.map((h) => h.tag);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag = slugify(headingMatch[2]);

      // Pop headings at same or deeper level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }

      if (tag) {
        headingStack.push({ level, tag });
      }
      continue;
    }

    // Skip code fences, HTML comments, horizontal rules
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('<!--')) continue;
    if (trimmed.startsWith('---')) continue;

    // Bullet points
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+\.\s+(.+)/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content.length > 3) {
        results.push({ content, tags: getCurrentTags() });
      }
      continue;
    }

    // Plain text with substance
    if (trimmed.length > 10 && !trimmed.startsWith('|')) {
      results.push({ content: trimmed, tags: getCurrentTags() });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main import command
// ---------------------------------------------------------------------------

export interface ImportOptions {
  format: 'chatgpt' | 'claude' | 'cursor' | 'file' | 'markdown';
  filePath: string;
  dryRun: boolean;
  global: boolean;
}

export function cmdImport(
  hippoRoot: string,
  options: ImportOptions
): void {
  const useGlobal = options.global;
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    if (!isInitialized(hippoRoot)) {
      console.error('No .hippo directory found. Run `hippo init` first.');
      process.exit(1);
    }
  }

  // Read source file
  if (!fs.existsSync(options.filePath)) {
    console.error(`File not found: ${options.filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(options.filePath, 'utf8');

  // Parse based on format
  let items: Array<{ content: string; tags: string[] }>;

  switch (options.format) {
    case 'chatgpt': {
      const memories = parseChatGPT(raw);
      items = memories.map((m) => ({ content: m, tags: ['chatgpt-import'] }));
      break;
    }
    case 'claude': {
      const memories = parseClaude(raw);
      items = memories.map((m) => ({ content: m, tags: ['claude-import'] }));
      break;
    }
    case 'cursor': {
      const memories = parseCursor(raw);
      items = memories.map((m) => ({ content: m, tags: ['cursor-import'] }));
      break;
    }
    case 'file': {
      const memories = parseFile(raw);
      items = memories.map((m) => ({ content: m, tags: ['file-import'] }));
      break;
    }
    case 'markdown': {
      items = parseMarkdown(raw).map((m) => ({
        content: m.content,
        tags: [...m.tags, 'markdown-import'],
      }));
      break;
    }
  }

  // Load existing memories for deduplication
  const existing = loadAllEntries(targetRoot);

  let imported = 0;
  let skipped = 0;

  for (const item of items) {
    if (isDuplicate(item.content, existing)) {
      skipped++;
      if (options.dryRun) {
        console.log(`  [skip] ${item.content.slice(0, 80)}...`);
      }
      continue;
    }

    if (options.dryRun) {
      const tagStr = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
      console.log(`  [import] ${item.content.slice(0, 100)}${tagStr}`);
    } else {
      const entry = createMemory(item.content, {
        layer: Layer.Episodic,
        tags: item.tags,
        source: `import-${options.format}`,
        confidence: 'inferred',
      });

      writeEntry(targetRoot, entry);
      updateStats(targetRoot, { remembered: 1 });

      // Also add to existing list for within-batch dedup
      existing.push(entry);

      if (isEmbeddingAvailable()) {
        embedMemory(targetRoot, entry).catch(() => {});
      }
    }

    imported++;
  }

  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = useGlobal ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Imported ${imported} memories (${skipped} skipped as duplicates)`
  );
}
