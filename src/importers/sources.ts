import * as fs from 'fs';
import * as path from 'path';
import { type ImportResult, type ImportOptions, importEntries, type JsonValue, isJsonString, isJsonPlainObject } from './core.js';
import { parseFrontmatter, collectMarkdownFiles } from './markdown-parse.js';

/** Coerce one imported record (string, `{content|text: ...}` object, or
 *  anything else) into the plain-text memory chunk it represents. */
function extractMemoryText(candidate: JsonValue): string {
  if (isJsonString(candidate)) return candidate;
  if (isJsonPlainObject(candidate)) {
    return String(candidate['content'] ?? candidate['text'] ?? '');
  }
  return '';
}

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
      const parsed: JsonValue = JSON.parse(raw);

      // {"memories": [...]} - ChatGPT export format
      if (isJsonPlainObject(parsed) && Array.isArray(parsed.memories)) {
        return parsed.memories.map(extractMemoryText).filter(Boolean);
      }

      // Array format
      if (Array.isArray(parsed)) {
        return parsed.map(extractMemoryText).filter(Boolean);
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
      const parsed: JsonValue = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed.map(extractMemoryText).filter(Boolean);
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

const CURSOR_RULE_FILE = /\.mdc?$/i;

/** Import `.cursorrules`, one rule file, or a `.cursor/rules` tree of `.mdc` and `.md` rules. */
export function importCursor(sourcePath: string, options: ImportOptions): ImportResult {
  const files = fs.statSync(sourcePath).isDirectory()
    ? collectMarkdownFiles(sourcePath, options.hippoRoot, CURSOR_RULE_FILE).map((rel) => path.join(sourcePath, rel))
    : [sourcePath];
  const chunks = files.flatMap((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    return parseCursorFile(CURSOR_RULE_FILE.test(file) ? parseFrontmatter(raw).body : raw);
  });
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
