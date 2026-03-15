/**
 * Capture actionable items from conversation text.
 *
 * Uses heuristic pattern matching (no LLM) to extract:
 *   - Decisions ("we decided", "let's do", "going with")
 *   - Specs / requirements (bullet lists after spec/feature/plan headings)
 *   - Rules / constraints ("never", "always", "the rule is", "must")
 *   - Errors / gotchas ("error:", "bug:", "gotcha:", "watch out")
 *   - Preferences ("prefer", "use X instead of Y", "don't use")
 */

import * as fs from 'fs';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import {
  isInitialized,
  writeEntry,
  loadAllEntries,
  updateStats,
} from './store.js';
import { getGlobalRoot, initGlobal } from './shared.js';
import { isEmbeddingAvailable, embedMemory } from './embeddings.js';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface ExtractedItem {
  content: string;
  category: string;   // decision | spec | rule | error | preference
  tags: string[];
}

// Sentence-level patterns
const DECISION_PATTERNS = [
  /(?:we(?:'ve| have)?|i(?:'ve| have)?|let's)\s+decid(?:ed|e)\s+(?:to\s+)?(.{10,200})/i,
  /(?:let's|we(?:'ll| will| should)?)\s+(?:go with|do|use|try|build|implement|switch to)\s+(.{5,200})/i,
  /(?:going|went)\s+with\s+(.{5,200})/i,
  /(?:the plan is|plan:)\s+(.{10,200})/i,
  /decision:\s*(.{10,200})/i,
];

const RULE_PATTERNS = [
  /(?:never|always|must(?:\s+not)?|do(?:n't| not)\s+ever)\s+(.{5,200})/i,
  /(?:the rule is|rule:)\s*(.{5,200})/i,
  /(?:important|critical|remember):\s*(.{10,200})/i,
  /(?:make sure|ensure)\s+(?:to\s+)?(.{10,200})/i,
];

const ERROR_PATTERNS = [
  /(?:error|bug|gotcha|watch out|careful|warning|caveat|trap):\s*(.{10,200})/i,
  /(?:this broke|this breaks|this will break|broke because)\s+(.{5,200})/i,
  /(?:the (?:issue|problem|fix) (?:is|was))\s+(.{10,200})/i,
  /(?:don't forget|easy to miss):\s*(.{5,200})/i,
];

const PREFERENCE_PATTERNS = [
  /(?:prefer|use)\s+(.{5,100})\s+(?:instead of|over|not)\s+(.{3,100})/i,
  /(?:don't use|avoid|skip)\s+(.{5,200})/i,
  /(?:we(?:'re| are)\s+using|the stack is|we use)\s+(.{5,200})/i,
];

// Heading patterns that signal a following list of specs/requirements
const SPEC_HEADING_PATTERNS = [
  /^#+\s*(?:features?|requirements?|specs?|specifications?|plan|design|architecture|interface|api|todo|tasks?|implementation|notes?)(?:\s|:)/i,
  /^(?:features?|requirements?|specs?|specifications?|plan|design|tasks?|implementation)(?:\s*:)/i,
];

// ---------------------------------------------------------------------------
// Extraction engine
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  // Split on sentence boundaries, keeping reasonable chunks
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

function cleanExtract(raw: string): string {
  return raw
    .replace(/^[:\s-]+/, '')
    .replace(/[.!?,;:\s]+$/, '')
    .trim();
}

function extractFromPatterns(
  sentence: string,
  patterns: RegExp[],
  category: string,
  tag: string
): ExtractedItem | null {
  for (const pat of patterns) {
    const match = sentence.match(pat);
    if (match) {
      // Use the captured group if available, otherwise the full match
      const raw = match[1] ?? match[0];
      const content = cleanExtract(raw);
      if (content.length >= 8 && content.length <= 500) {
        return { content, category, tags: [tag, 'captured'] };
      }
    }
  }
  return null;
}

/** Extract spec items from bullet lists that follow spec-like headings. */
function extractSpecSections(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const lines = text.split('\n');

  let inSpecSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this line is a spec heading
    if (SPEC_HEADING_PATTERNS.some((p) => p.test(trimmed))) {
      inSpecSection = true;
      continue;
    }

    // Another heading resets the section
    if (/^#+\s/.test(trimmed) || /^[A-Z][a-z]+:$/.test(trimmed)) {
      inSpecSection = false;
      continue;
    }

    // Blank line after non-bullet content ends section
    if (!trimmed && inSpecSection) {
      // Keep going, blank lines within spec sections are ok
      continue;
    }

    if (inSpecSection) {
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+\.\s+(.+)/);
      if (bulletMatch) {
        const content = bulletMatch[1].trim();
        if (content.length >= 8 && content.length <= 500) {
          items.push({
            content,
            category: 'spec',
            tags: ['spec', 'captured'],
          });
        }
      }
    }
  }

  return items;
}

/**
 * Main extraction function. Scans text for actionable items using heuristics.
 */
export function extractFromText(text: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const seen = new Set<string>();

  const addIfNew = (item: ExtractedItem): void => {
    const norm = item.content.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seen.has(norm)) {
      seen.add(norm);
      items.push(item);
    }
  };

  // 1. Extract spec sections (bullet lists under spec headings)
  for (const item of extractSpecSections(text)) {
    addIfNew(item);
  }

  // 2. Pattern-match on individual sentences
  const sentences = splitSentences(text);

  for (const sentence of sentences) {
    // Try each category in priority order
    const decision = extractFromPatterns(sentence, DECISION_PATTERNS, 'decision', 'decision');
    if (decision) { addIfNew(decision); continue; }

    const rule = extractFromPatterns(sentence, RULE_PATTERNS, 'rule', 'rule');
    if (rule) { addIfNew(rule); continue; }

    const error = extractFromPatterns(sentence, ERROR_PATTERNS, 'error', 'error');
    if (error) { addIfNew(error); continue; }

    const preference = extractFromPatterns(sentence, PREFERENCE_PATTERNS, 'preference', 'preference');
    if (preference) { addIfNew(preference); continue; }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Normalisation for deduplication (mirrors import.ts)
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
  if (!norm) return true;
  for (const e of existing) {
    if (normalise(e.content) === norm) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  source: 'stdin' | 'file' | 'last-session';
  filePath?: string;
  dryRun: boolean;
  global: boolean;
}

export function cmdCapture(
  hippoRoot: string,
  options: CaptureOptions
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

  // Read input text
  let text: string;

  switch (options.source) {
    case 'stdin': {
      try {
        text = fs.readFileSync(0, 'utf8');
      } catch {
        console.error('No input on stdin. Pipe text in or use --file <path>.');
        process.exit(1);
      }
      break;
    }
    case 'file': {
      if (!options.filePath) {
        console.error('Missing file path. Usage: hippo capture --file <path>');
        process.exit(1);
      }
      if (!fs.existsSync(options.filePath)) {
        console.error(`File not found: ${options.filePath}`);
        process.exit(1);
      }
      text = fs.readFileSync(options.filePath, 'utf8');
      break;
    }
    case 'last-session': {
      console.log('--last-session is a placeholder. Not yet implemented.');
      console.log('Use --stdin or --file instead.');
      return;
    }
  }

  if (!text || text.trim().length === 0) {
    console.log('No text to capture from.');
    return;
  }

  // Extract items
  const extracted = extractFromText(text);

  if (extracted.length === 0) {
    console.log('No actionable items found in the input.');
    return;
  }

  // Load existing for dedup
  const existing = loadAllEntries(targetRoot);

  let captured = 0;
  let skipped = 0;

  for (const item of extracted) {
    if (isDuplicate(item.content, existing)) {
      skipped++;
      if (options.dryRun) {
        console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
      }
      continue;
    }

    if (options.dryRun) {
      console.log(`  [capture] (${item.category}) ${item.content}`);
    } else {
      const entry = createMemory(item.content, {
        layer: Layer.Episodic,
        tags: item.tags,
        source: 'capture',
        confidence: 'observed',
      });

      writeEntry(targetRoot, entry);
      updateStats(targetRoot, { remembered: 1 });
      existing.push(entry); // within-batch dedup

      if (isEmbeddingAvailable()) {
        embedMemory(targetRoot, entry).catch(() => {});
      }
    }

    captured++;
  }

  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = useGlobal ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Captured ${captured} items (${skipped} skipped as duplicates)`
  );
}
