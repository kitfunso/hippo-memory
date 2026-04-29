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
import * as path from 'path';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import { isContentWorthStoring } from './audit.js';
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
  /^#+\s*(?:features?|requirements?|specs?|specifications?|plan|design|architecture|interface|api|todo|tasks?|implementation|notes?)(?:\s|:|$)/i,
  /^(?:features?|requirements?|specs?|specifications?|plan|design|tasks?|implementation)(?:\s*:|$)/i,
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
    if (seen.has(norm)) return;
    if (!isContentWorthStoring(item.content)) return;
    seen.add(norm);
    items.push(item);
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
  /**
   * Explicit transcript path for `--last-session`. When not set, we fall back
   * to reading a JSON payload from stdin (the shape Claude Code / OpenCode
   * SessionEnd hooks pass) and then to auto-discovery under
   * `~/.claude/projects/`.
   */
  transcriptPath?: string;
  /**
   * Tee stdout/stderr to this log file while capture runs. Mirrors the
   * pattern used by `hippo sleep --log-file` so the SessionEnd hook output
   * (invisible during TUI teardown) can be surfaced via `hippo last-sleep`
   * on the next session start. Appends rather than truncates — `hippo sleep`
   * writes the same file first in the SessionEnd sequence.
   */
  logFile?: string;
  dryRun: boolean;
  global: boolean;
}

/**
 * Build a compact text summary from a Claude Code / OpenCode JSONL transcript.
 * Keeps plain user messages and the final chunk of assistant text, drops
 * thinking blocks, tool_use, and tool_result noise. Output is fed to the
 * existing `extractFromText` pipeline.
 *
 * Exported for tests.
 */
export function summariseTranscript(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  const userMessages: string[] = [];
  const assistantTexts: string[] = [];

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (e.type === 'user' || e.type === 'assistant') {
      const message = e.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const content = message.content;

      if (e.type === 'user') {
        // Plain text user messages only (skip tool_result arrays)
        if (typeof content === 'string' && content.trim()) {
          userMessages.push(content.trim());
        }
      } else if (Array.isArray(content)) {
        // Keep assistant text blocks; drop thinking + tool_use
        const chunks: string[] = [];
        for (const block of content) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              chunks.push(b.text.trim());
            }
          }
        }
        if (chunks.length > 0) {
          assistantTexts.push(chunks.join('\n'));
        }
      }
      continue;
    }

    // Codex rollout transcript shape: response_item -> payload.message
    if (e.type === 'response_item') {
      const payload = e.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== 'message') continue;
      const role = payload.role;
      const content = payload.content;
      if (!Array.isArray(content)) continue;

      const chunks: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (role === 'user' && b.type === 'input_text' && typeof b.text === 'string' && b.text.trim()) {
          chunks.push(b.text.trim());
        }
        if (role === 'assistant' && b.type === 'output_text' && typeof b.text === 'string' && b.text.trim()) {
          chunks.push(b.text.trim());
        }
      }

      if (chunks.length === 0) continue;
      if (role === 'user') userMessages.push(chunks.join('\n'));
      if (role === 'assistant') assistantTexts.push(chunks.join('\n'));
    }
  }

  if (userMessages.length === 0 && assistantTexts.length === 0) return '';

  // Keep the tail: last ~20 user turns and last ~10 assistant replies.
  // Session-end is about what was decided near the end, not at the start.
  const tailUsers = userMessages.slice(-20);
  const tailAssistants = assistantTexts.slice(-10);

  return [
    '# Session Summary',
    '',
    '## User Messages',
    ...tailUsers.map((m) => `- ${m.replace(/\s+/g, ' ').slice(0, 500)}`),
    '',
    '## Assistant Responses',
    ...tailAssistants.map((t) => t.slice(0, 2000)),
  ].join('\n');
}

/**
 * Resolve a transcript path for `--last-session`.
 *
 * Priority:
 *   1. Explicit `transcriptPath` option (from `--transcript <path>`)
 *   2. Stdin JSON payload (Claude Code / OpenCode SessionEnd hook shape)
 *   3. Most recent `.jsonl` under `~/.claude/projects/<any>/`
 *
 * Returns null when nothing resolves. Never throws.
 */
export function resolveLastSessionTranscript(
  explicit: string | undefined,
  stdinText: string | undefined
): string | null {
  if (explicit && fs.existsSync(explicit)) return explicit;

  // Try parsing stdin as the SessionEnd JSON payload
  if (stdinText && stdinText.trim().startsWith('{')) {
    try {
      const payload = JSON.parse(stdinText) as Record<string, unknown>;
      const tp = payload.transcript_path;
      if (typeof tp === 'string' && fs.existsSync(tp)) return tp;
    } catch {
      // not JSON - fall through
    }
  }

  // Auto-discover the most recent transcript
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const entry of fs.readdirSync(projectsDir)) {
      const subDir = path.join(projectsDir, entry);
      const stat = fs.statSync(subDir);
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(subDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const full = path.join(subDir, file);
        const m = fs.statSync(full).mtimeMs;
        if (!newest || m > newest.mtime) newest = { path: full, mtime: m };
      }
    }
  } catch {
    return null;
  }
  return newest?.path ?? null;
}

export function cmdCapture(
  hippoRoot: string,
  options: CaptureOptions
): void {
  // Tee stdout/stderr to a log file when --log-file is set. Used by the
  // SessionEnd hook so output (otherwise swallowed by TUI teardown) surfaces
  // on the next session start via `hippo last-sleep`. Runs second in the
  // SessionEnd sequence after `hippo sleep`, so we APPEND rather than
  // truncate — sleep already wrote its own header + body to this file.
  const restoreStdio = options.logFile ? beginLogTee(options.logFile) : null;
  try {
    cmdCaptureCore(hippoRoot, options);
    if (options.logFile) console.log('[hippo] capture complete');
  } catch (err) {
    if (options.logFile) console.log(`[hippo] capture failed: ${(err as Error).message}`);
    throw err;
  } finally {
    if (restoreStdio) restoreStdio();
  }
}

/**
 * Append-mode tee: writes a banner line then mirrors every stdout/stderr
 * chunk to `logFile` until the returned restore function is called.
 * Failures to write the log are non-fatal; the real streams still get
 * the data.
 */
function beginLogTee(logFile: string): () => void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(
      logFile,
      `[hippo] ${new Date().toISOString()} capturing session...\n`,
      'utf8'
    );
  } catch (err) {
    console.error(`[hippo] warning: could not open log file ${logFile}: ${(err as Error).message}`);
    return () => {};
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const tee = (chunk: unknown): void => {
    try {
      const buf =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
      fs.appendFileSync(logFile, buf, 'utf8');
    } catch {
      // log failures are non-fatal
    }
  };
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
    tee(chunk);
    return (origStdoutWrite as (...args: unknown[]) => boolean)(chunk, enc, cb);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
    tee(chunk);
    return (origStderrWrite as (...args: unknown[]) => boolean)(chunk, enc, cb);
  }) as typeof process.stderr.write;

  return () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
}

function cmdCaptureCore(
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
      // Try to read stdin non-blockingly: SessionEnd hooks pass a JSON payload,
      // but manual / test invocations have no piped stdin. fs.readFileSync(0)
      // will block waiting for input when run interactively, so:
      //   - skip entirely when caller passed an explicit --transcript path
      //   - skip when stdin is a TTY (interactive shell)
      let stdinText: string | undefined;
      if (!options.transcriptPath && !process.stdin.isTTY) {
        try {
          stdinText = fs.readFileSync(0, 'utf8');
        } catch {
          stdinText = undefined;
        }
      }

      const resolved = resolveLastSessionTranscript(options.transcriptPath, stdinText);
      if (!resolved) {
        console.log('No transcript found. Pass --transcript <path> or run from a SessionEnd hook.');
        return;
      }

      const jsonl = fs.readFileSync(resolved, 'utf8');
      text = summariseTranscript(jsonl);
      if (!text) {
        console.log('Transcript had no user/assistant messages to summarise.');
        return;
      }
      break;
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
      // A3: kind defaults to 'distilled'. capture.ts extracts curated items from
      // session output (not raw transcript chunks), so distilled is correct. If a
      // future variant captures full raw session text, it MUST set kind: 'raw'
      // and route deletions through archiveRawMemory(). See MEMORY_ENVELOPE.md.
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
