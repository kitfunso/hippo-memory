import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ImportResult, type TargetedImport, importEntriesInto } from './core.js';
import { splitMarkdownFrontmatter, collectMarkdownFiles } from './markdown-parse.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { type JsonValue, isJsonString, isJsonObject } from '../../base/util/json.js';

function extractMemoryText(candidate: JsonValue): string {
  if (isJsonString(candidate)) return candidate;
  if (isJsonObject(candidate)) {
    return String(candidate['content'] ?? candidate['text'] ?? '');
  }
  return '';
}

function parseChatGPTFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed: JsonValue = JSON.parse(raw);

      if (isJsonObject(parsed) && Array.isArray(parsed.memories)) {
        return parsed.memories.map(extractMemoryText).filter(Boolean);
      }

      if (Array.isArray(parsed)) {
        return parsed.map(extractMemoryText).filter(Boolean);
      }
    } catch (err) {
      log.warn(
        `import: ${filePath} is not valid JSON (${errorMessage(err)}); reading it as plain text`,
        errorFields(err),
      );
    }
  }

  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function importChatGPTInto(filePath: string, options: TargetedImport): ImportResult {
  const chunks = parseChatGPTFile(filePath);
  return importEntriesInto(chunks, 'import:chatgpt', ['imported', 'chatgpt'], options);
}

const HIPPO_START = '<!-- hippo:start -->';
const HIPPO_END = '<!-- hippo:end -->';

function stripHippoBlock(content: string): string {
  const startIdx = content.indexOf(HIPPO_START);
  const endIdx = content.indexOf(HIPPO_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + HIPPO_END.length);
}

function splitMarkdown(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) current = appendLine(chunks, current, line);

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function appendLine(chunks: string[], open: string, line: string): string {
  let current = open;
  const trimmed = line.trim();

  if (/^#{1,6}\s+/.test(trimmed)) {
    if (current.trim()) chunks.push(current.trim());
    current = trimmed;
    return current;
  }

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
    return current;
  }

  if (/^\d+\.\s+/.test(trimmed)) {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    current = trimmed.replace(/^\d+\.\s+/, '').trim();
    return current;
  }

  if (!trimmed) {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
    return current;
  }

  return current ? current + ' ' + trimmed : trimmed;
}

function parseClaudeFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');

  if (filePath.endsWith('.json')) {
    try {
      const parsed: JsonValue = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed.map(extractMemoryText).filter(Boolean);
      }
    } catch (err) {
      log.warn(
        `import: ${filePath} is not valid JSON (${errorMessage(err)}); reading it as markdown`,
        errorFields(err),
      );
    }
  }

  const cleaned = stripHippoBlock(raw);
  return splitMarkdown(cleaned);
}

export function importClaudeInto(filePath: string, options: TargetedImport): ImportResult {
  const chunks = parseClaudeFile(filePath);
  return importEntriesInto(chunks, 'import:claude', ['imported', 'claude'], options);
}

function parseCursorFile(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed === '#') {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    const ruleStart = cursorRuleStart(trimmed);
    if (ruleStart !== null) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = ruleStart;
      continue;
    }

    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.flatMap((c) => {
    const parts = c.split(/\n{2,}/);
    return parts.map((p) => p.trim()).filter(Boolean);
  });
}

function cursorRuleStart(trimmed: string): string | null {
  if (/^\d+\.\s+/.test(trimmed)) return trimmed.replace(/^\d+\.\s+/, '').trim();
  if (/^[-*]\s+/.test(trimmed)) return trimmed.replace(/^[-*]\s+/, '').trim();
  return null;
}

const CURSOR_RULE_FILE = /\.mdc?$/i;

/** Import `.cursorrules`, one rule file, or a `.cursor/rules` tree of `.mdc` and `.md` rules. */
export function importCursorInto(sourcePath: string, options: TargetedImport): ImportResult {
  const files = fs.statSync(sourcePath).isDirectory()
    ? collectMarkdownFiles(sourcePath, options.hippoRoot, CURSOR_RULE_FILE).map((rel) =>
        path.join(sourcePath, rel),
      )
    : [sourcePath];
  const chunks = files.flatMap((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    return parseCursorFile(CURSOR_RULE_FILE.test(file) ? splitMarkdownFrontmatter(raw).body : raw);
  });
  return importEntriesInto(chunks, 'import:cursor', ['imported', 'cursor'], options);
}

function parseGenericFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');

  if (isMarkdown) {
    return splitMarkdown(raw);
  }

  const byParagraph = raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;

  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function importGenericFileInto(filePath: string, options: TargetedImport): ImportResult {
  const chunks = parseGenericFile(filePath);
  return importEntriesInto(chunks, 'import:file', ['imported'], options);
}
