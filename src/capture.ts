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
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  type TaskSnapshot,
} from './store.js';
import { getGlobalRoot, initGlobal } from './shared.js';
import { embedMemory } from './embeddings.js';
import { isEmbeddingConfigured } from './embedding-provider.js';
import { resolveTenantId } from './tenant.js';
import { defaultPreCompactLogPath } from './hooks.js';
import { redactSecrets } from './secret-detect.js';
import { RejectedValueError, checkRejectionGuard } from './rejection.js';
import { openHippoDb, closeHippoDb } from './db.js';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

export interface ExtractedItem {
  content: string;
  category: string;   // decision | spec | rule | error | preference
  tags: string[];
}

// Sentence-level patterns
//
// T1 (DF2): each pattern now carries TWO capture groups — group 1 is the
// discriminating keyword (plus its trailing separator, verbatim), group 2 is
// the content that follows it. Previously only the after-keyword content was
// captured, so a negation like "never" / "must not" was discarded and a
// prohibition inverted into an instruction ("Never use X" stored as "use X").
// `extractFromPatterns` reassembles group1 + a clause-bounded group2 (T2, via
// `boundToClause` below) rather than reading a single fixed-width group —
// group 2's own reach is widened to {1,500} because the true stopping point
// is now found by content, not counted characters. Keeping the keyword in
// its own group (rather than folding it into one bigger capture) matters:
// `boundToClause` must scan for a clause boundary only in group 2, never in
// group 1 — several keywords end in their own colon ("error:", "rule:",
// "decision:") which is not a clause boundary in the prose sense and would
// wrongly truncate the capture down to just the keyword if scanned.
// `PREFERENCE_PATTERNS[0]` is the one exception — its two-capture-group
// shape means something different (two content spans either side of
// "instead of"/"over"/"not") and is a separate, backlogged defect (see
// docs/plans/2026-08-23-df2-capture-anchoring.md); left as-is.
const DECISION_PATTERNS = [
  /(?:we(?:'ve| have)?|i(?:'ve| have)?|let's)\s+(decid(?:ed|e)\s+(?:to\s+)?)(.{1,500})/i,
  /(?:let's|we(?:'ll| will| should)?)\s+((?:go with|do|use|try|build|implement|switch to)\s+)(.{1,500})/i,
  /((?:going|went)\s+with\s+)(.{1,500})/i,
  /((?:the plan is|plan:)\s+)(.{1,500})/i,
  /(decision:\s*)(.{1,500})/i,
];

const RULE_PATTERNS = [
  /((?:never|always|must(?:\s+not)?|do(?:n't| not)\s+ever)\s+)(.{1,500})/i,
  /((?:the rule is|rule:)\s*)(.{1,500})/i,
  /((?:important|critical|remember):\s*)(.{1,500})/i,
  /((?:make sure|ensure)\s+(?:to\s+)?)(.{1,500})/i,
];

const ERROR_PATTERNS = [
  /((?:error|bug|gotcha|watch out|careful|warning|caveat|trap):\s*)(.{1,500})/i,
  /((?:this broke|this breaks|this will break|broke because)\s+)(.{1,500})/i,
  /((?:the (?:issue|problem|fix) (?:is|was))\s+)(.{1,500})/i,
  /((?:don't forget|easy to miss):\s*)(.{1,500})/i,
];

// PREFERENCE_PATTERNS[0] keeps its pre-DF2 two-capture-group shape
// (match[1]-only, unbounded) — out of scope here, backlogged. See
// extractFromPatterns' reference check against this exact array element.
const PREFERENCE_PATTERNS = [
  /(?:prefer|use)\s+(.{5,100})\s+(?:instead of|over|not)\s+(.{3,100})/i,
  /((?:don't use|avoid|skip)\s+)(.{1,500})/i,
  /((?:we(?:'re| are)\s+using|the stack is|we use)\s+)(.{1,500})/i,
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

/**
 * T2 (DF2): bound a keyword+content capture to its clause instead of a fixed
 * character count. `full` is `keywordPrefix + content` (already concatenated
 * so the 200-char ceiling below applies to the whole stored string, not just
 * the part after the keyword); `searchFrom` is `keywordPrefix.length`, so the
 * clause/terminator scan only ever looks INSIDE `content` — several keywords
 * end in their own colon ("error:", "rule:", "decision:") which must never
 * be mistaken for a clause boundary in the prose that follows.
 *
 * Stops at the first `,`/`;`/`:` followed by whitespace, or at a sentence
 * terminator `[.!?]` followed by whitespace or end-of-string — whichever
 * comes first — and never past `maxLen` chars total.
 *
 * The whitespace requirement on the terminator is load-bearing: a bare
 * `[.!?]` would split inside a token like `.env` / `capture.ts` / `v1.35.0`,
 * turning a full clause into a fragment that then fails the write gate and
 * is silently dropped (measured in the plan). The `maxLen` ceiling is also
 * load-bearing: without it, a clause-free span can run past the 500-char
 * gate in `extractFromPatterns` and the whole match is dropped, where today
 * it is truncated and stored.
 */
/**
 * Does a plausible CLOSING single quote appear after `from`? Mirror of the
 * opener rule in `boundToClause`: a closer sits tight against the literal it
 * ends (non-whitespace before) and is followed by whitespace, punctuation, or
 * end-of-string - never by a letter, which is what makes "user's" an
 * apostrophe rather than a partner.
 */
function lastCloserIndex(full: string): number {
  // ONE pass, not one per apostrophe. The previous shape rescanned the whole
  // remaining suffix at every boundary apostrophe, so a transcript full of
  // elisions ("keep 'em", "wait 'til", ...) made extraction quadratic and
  // could stall a moderately sized capture. Codex P2, r7.
  //
  // A closer is an apostrophe NOT followed by a letter or digit. The earlier
  // rule also demanded non-whitespace BEFORE it, which rejected the genuine
  // closer in "Always preserve 'a, b ' exactly" and re-cut inside the
  // literal (codex P2, r7). What actually distinguishes a closer from an
  // in-word apostrophe is only what FOLLOWS it: "user's" has a letter, a
  // closer has space, punctuation, or end-of-string.
  for (let j = full.length - 1; j >= 0; j--) {
    if (full[j] !== "'") continue;
    const next = full[j + 1];
    if (next === undefined || !/[\p{L}\p{N}]/u.test(next)) return j;
  }
  return -1;
}

function boundToClause(full: string, searchFrom: number, maxLen = 200): string {
  // Scan for the first PROSE clause boundary after `searchFrom`.
  //
  // Depth-awareness is not a nicety here: hippo memories are full of code, and
  // a naive scan reintroduces the exact fragment defect this whole change
  // exists to remove. Measured before this guard existed:
  //   "Always call build(x, y) before deploy."  ->  "Always call build(x"
  //   "Never pass {a: 1, b: 2} to the writer."  ->  "Never pass {a"
  // Both then PASS the write gate, because they contain code punctuation and
  // so read as "specific" — a malformed fragment stored with high confidence.
  // Codex review finding (P1) on this branch.
  //
  // So: a separator only ends the clause at bracket depth zero and outside
  // quotes. Unbalanced closers are tolerated (depth floors at 0) because
  // captured text often starts mid-expression.
  const lastCloser = lastCloserIndex(full);
  let depth = 0;
  let quote: string | null = null;
  let cutEnd = full.length;

  for (let i = searchFrom; i < full.length; i++) {
    const ch = full[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    // Quote handling has to tell an APOSTROPHE from a single-quoted
    // LITERAL, because getting either wrong reintroduces the fragment
    // defect this change exists to remove, and both fragments PASS the
    // write gate (code punctuation reads as "specific"):
    //   treat every ' as a quote  -> "Always ensure it's enabled, then
    //     restart..." never leaves quote mode, bounding disabled entirely
    //   treat no ' as a quote     -> "Always pass 'a, b' to the parser."
    //     cuts at the comma and stores "Always pass 'a"
    // Both were codex P1s on this branch, in consecutive rounds.
    //
    // Discriminator: a ' OPENS a literal only at a word boundary - preceded
    // by start/whitespace/open-bracket AND followed by non-whitespace. An
    // in-word apostrophe ("it's", "user's") has letters on both sides and is
    // just a character.
    if (ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === "'") {
      const prev = i > 0 ? full[i - 1] : undefined;
      const next = full[i + 1];
      const atBoundary =
        (prev === undefined || /[\s([{]/.test(prev)) &&
        next !== undefined && !/\s/.test(next);
      // Pairing is VERIFIED, not assumed. A word-boundary test alone still
      // opens quote mode on elided forms ("keep 'em", "wait 'til"), which
      // have no closer, so the scanner never leaves quote mode and bounding
      // is disabled for the rest of the capture. Requiring an actual closing
      // quote later in the string replaces a guess with a checkable fact -
      // an elided form simply has no partner. Codex P2, this round.
      // ...and the partner must LOOK like a closer, not merely be another
      // apostrophe. Distance cannot separate the two cases - both put a `'`
      // far downstream:
      //   "Always pass '<600-char literal>' to the parser"  -> the far ' IS
      //     the closer, and pairing must succeed
      //   "keep 'em enabled, then <520 chars> check user's config" -> the far
      //     ' is in-word, and pairing against it re-opens quote mode on the
      //     elision, disabling bounding for the rest of the capture
      // So apply the SAME shape rule already used to open a literal, mirrored:
      // a closer has non-whitespace before it and whitespace/punctuation (not
      // a letter) after. "user's" fails it on both counts. Codex P2, r6.
      if (atBoundary && lastCloser > i) { quote = ch; }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; continue; }
    if (depth > 0) continue;

    const next = full[i + 1];
    // Prose clause separator: , ; : followed by whitespace.
    if ((ch === ',' || ch === ';' || ch === ':') && next !== undefined && /\s/.test(next)) {
      cutEnd = i;
      break;
    }
    // Sentence terminator, but only when followed by whitespace or end — a
    // bare [.!?] splits inside .env, capture.ts, v1.35.0.
    if ((ch === '.' || ch === '!' || ch === '?') && (next === undefined || /\s/.test(next))) {
      cutEnd = i + 1;
      break;
    }
  }

  let bounded = full.slice(0, cutEnd);
  if (bounded.length > maxLen) bounded = bounded.slice(0, maxLen);
  return bounded;
}

function cleanExtract(raw: string): string {
  let content = raw
    .replace(/^[:\s-]+/, '')
    .replace(/[.!?,;:\s]+$/, '')
    .trim();

  // T2 trailing cleanup: clause-bounding can cut inside a parenthetical and
  // leave an unmatched trailing ')' (e.g. "...(two had never got entries),"
  // bounds to "never got entries)"). Strip a trailing ')' ONLY while closes
  // outnumber opens in the string so far — a balanced parenthetical like
  // "always run the suite (twice)" must be left intact.
  while (content.endsWith(')')) {
    const opens = (content.match(/\(/g) ?? []).length;
    const closes = (content.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    content = content
      .slice(0, -1)
      .replace(/[.!?,;:\s]+$/, '')
      .trim();
  }

  return content;
}

function extractFromPatterns(
  sentence: string,
  patterns: RegExp[],
  category: string,
  tag: string
): ExtractedItem | null {
  for (const pat of patterns) {
    // `d` gives per-group offsets; see the contentStart comment below.
    const dpat = pat.flags.includes('d') ? pat : new RegExp(pat.source, pat.flags + 'd');
    const match = dpat.exec(sentence);
    if (match) {
      let bounded: string;
      if (pat === PREFERENCE_PATTERNS[0]) {
        // PREFERENCE_PATTERNS[0] is the one pattern left out of T1/T2 (see
        // comment at its definition) — its match[1] keeps its pre-DF2,
        // unbounded shape rather than going through clause-bounding.
        bounded = match[1] ?? match[0];
      } else {
        // group1 = keyword + separator (verbatim, never clause-bounded);
        // group2 = the content that follows it (clause-bounded below).
        //
        // T1 preserves the keyword only when it carries SEMANTIC SIGN — a
        // negation or modality ("never", "must not", "do not ever",
        // "always"). Dropping those inverts the meaning, which is the whole
        // point of T1. A LABEL keyword ("decision:", "rule:", "error:",
        // "important:") carries no sign: it only names the category, which
        // is already recorded in `category`/`tags`, so prefixing it onto the
        // content is duplication that also breaks value-keyed matching
        // (AT1's rejected-value digest hashes the bare content).
        // Discriminator: a label ends in its own colon, or is a "the X is"
        // phrase.
        const rawPrefix = match[1] ?? '';
        const isLabelPrefix = /:\s*$/.test(rawPrefix) || /^\s*the\s+\w+\s+(?:is|was)\s*$/i.test(rawPrefix);
        const keywordPrefix = isLabelPrefix ? '' : rawPrefix;
        // Scan the UNTRUNCATED remainder, not match[2]. The patterns cap
        // their content group at 500 chars, so a quoted literal whose closer
        // sits past that point had no visible partner and the pairing check
        // read the opener as prose - cutting inside the literal. That was a
        // blindness built into the scanner's INPUT, not a bad predicate, so
        // no further predicate could have fixed it. boundToClause already
        // caps its OUTPUT at maxLen, so widening the input costs nothing and
        // makes pairing decidable on the whole sentence. Codex P2, round 5.
        // Group 2's REAL offset, read from the regex engine. Deriving it as
        // `match.index + rawPrefix.length` assumes group 1 starts the match,
        // but DECISION_PATTERNS carry an uncaptured subject ("we ", "let's ")
        // ahead of it - so the offset landed inside the keyword and the
        // widened slice duplicated text: "We decided to pin..." stored as
        // "decided to to pin...". Real corruption of the commonest decision
        // capture, shipped in the previous commit. Codex P1, r6.
        const contentStart = match.indices?.[2]?.[0] ?? -1;
        const afterKeyword = contentStart >= 0 ? sentence.slice(contentStart) : (match[2] ?? match[0]);
        bounded = boundToClause(keywordPrefix + afterKeyword, keywordPrefix.length);
      }
      const content = cleanExtract(bounded);
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

/**
 * Write already-extracted items to the store, deduped against existing
 * tenant-scoped entries. Shared write path for `cmdCapture` (extracted from
 * raw text inline) and `cmdPreCompact` (extracted from a pre-computed tail
 * summary, no raw-text re-extraction). Mirrors the non-dry-run write loop in
 * `cmdCaptureCore`: same layer/source/confidence, same embed-if-configured,
 * fire-and-forget behaviour.
 *
 * Returns the fire-and-forget `embedMemory` promises alongside the counts
 * (review round X6) so a caller that must not exit before embeddings settle
 * — `cmdPreCompact`, which runs process.exit(0) right after — can await them
 * with a bounded timeout instead of racing a detached write.
 */
function writeExtractedItems(
  hippoRoot: string,
  tenantId: string,
  extracted: ExtractedItem[],
) {
  if (extracted.length === 0) return { captured: 0, skipped: 0, rejected: 0, embeds: [] };

  const existing = loadAllEntries(hippoRoot, tenantId);
  const embeds: Promise<unknown>[] = [];
  let captured = 0;
  let skipped = 0;
  let rejected = 0;

  for (const item of extracted) {
    if (isDuplicate(item.content, existing)) {
      skipped++;
      continue;
    }
    const entry = createMemory(item.content, {
      layer: Layer.Episodic,
      tags: item.tags,
      source: 'capture',
      confidence: 'observed',
      tenantId,
    });
    // AT1 (plan §3 containment): a refusal is per-VALUE — one rejected
    // extraction must not abort the rest of this transcript's captures.
    try {
      writeEntry(hippoRoot, entry);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejected++;
        continue;
      }
      throw err;
    }
    updateStats(hippoRoot, { remembered: 1 });
    existing.push(entry); // within-batch dedup
    if (isEmbeddingConfigured(hippoRoot)) {
      embeds.push(embedMemory(hippoRoot, entry).catch(() => {}));
    }
    captured++;
  }

  return { captured, skipped, rejected, embeds };
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
  /**
   * L9: tenant scope for the dedup read in `cmdCaptureCore`. When provided
   * AND `global` is false, the dedup check only considers this tenant's
   * existing memories. Undefined preserves pre-1.12.1 host-wide dedup
   * behaviour. Ignored when `global: true` (global captures are host-wide).
   */
  tenantId?: string;
}

/**
 * Runtime shape guards used throughout this file wherever a value arrives
 * unparsed (JSONL transcript records, stdout/stderr write() chunks). Generic
 * over the input so the parameter is never annotated `unknown` directly — TS
 * infers it from the call site — while the check itself avoids `typeof` by
 * testing identity against the coercion (`String(x) === x`) /
 * prototype-chain (`instanceof Object`) instead. Behaviourally equivalent to
 * `typeof x === 'string'` / a truthy `typeof x === 'object'` check for
 * anything `JSON.parse` can produce (the only divergence is boxed
 * primitives, which JSON.parse never yields).
 */
function isStringValue<T>(value: T): value is T & string {
  return String(value) === value;
}

function isObjectLike<T>(value: T): value is T & object {
  return value !== null && value instanceof Object;
}

/** Message for a caught value of unknown shape. `cause` names the sanctioned unknown-input case (error-cause enrichment). */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
    if (!isObjectLike(entry)) continue;

    if (('type' in entry) && (entry.type === 'user' || entry.type === 'assistant')) {
      const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
      if (!message) continue;
      const content = 'content' in message ? message.content : undefined;

      if (entry.type === 'user') {
        // Plain text user messages only (skip tool_result arrays)
        if (isStringValue(content) && content.trim()) {
          userMessages.push(content.trim());
        }
      } else if (Array.isArray(content)) {
        // Keep assistant text blocks; drop thinking + tool_use
        const chunks: string[] = [];
        for (const block of content) {
          if (isObjectLike(block)) {
            const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
            if (isStringValue(blockText) && blockText.trim()) {
              chunks.push(blockText.trim());
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
    if ('type' in entry && entry.type === 'response_item') {
      const payload = 'payload' in entry && isObjectLike(entry.payload) ? entry.payload : undefined;
      if (!payload || !('type' in payload) || payload.type !== 'message') continue;
      const role = 'role' in payload ? payload.role : undefined;
      const content = 'content' in payload ? payload.content : undefined;
      if (!Array.isArray(content)) continue;

      const chunks: string[] = [];
      for (const block of content) {
        if (!isObjectLike(block)) continue;
        const blockType = 'type' in block ? block.type : undefined;
        const blockText = 'text' in block ? block.text : undefined;
        if (role === 'user' && blockType === 'input_text' && isStringValue(blockText) && blockText.trim()) {
          chunks.push(blockText.trim());
        }
        if (role === 'assistant' && blockType === 'output_text' && isStringValue(blockText) && blockText.trim()) {
          chunks.push(blockText.trim());
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
      const payload: unknown = JSON.parse(stdinText);
      if (isObjectLike(payload) && 'transcript_path' in payload) {
        const tp = payload.transcript_path;
        if (isStringValue(tp) && fs.existsSync(tp)) return tp;
      }
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
    if (options.logFile) console.log(`[hippo] capture failed: ${errorMessage(err)}`);
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
    console.error(`[hippo] warning: could not open log file ${logFile}: ${errorMessage(err)}`);
    return () => {};
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const tee = (chunk: string | Uint8Array): void => {
    try {
      const buf = isStringValue(chunk) ? chunk : Buffer.from(chunk).toString('utf8');
      fs.appendFileSync(logFile, buf, 'utf8');
    } catch {
      // log failures are non-fatal
    }
  };
  // Node's `write` is overloaded (`(chunk, cb?)` vs `(chunk, encoding, cb?)`);
  // this wraps whichever of the two shapes was actually called, forwarding
  // to the same real stream method so runtime behaviour is unchanged.
  type StreamWriteArgs = [
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ];
  const wrapWrite = (origWrite: typeof process.stdout.write): typeof process.stdout.write => {
    const wrapped = (...args: StreamWriteArgs): boolean => {
      tee(args[0]);
      // SAFETY: forwarding the exact arguments Node's real overloaded
      // `write` received is safe regardless of which overload the call
      // site used — Node dispatches on the actual argument shapes at
      // runtime, and `StreamWriteArgs` is the union of both overloads'
      // parameter lists.
      return (origWrite as (...args: StreamWriteArgs) => boolean)(...args);
    };
    // SAFETY: `wrapped` matches both real `write` overload shapes it's
    // assigned to; TS can't verify a single implementation covers an
    // overloaded type, but this one forwards to the real stream method.
    return wrapped as typeof process.stdout.write;
  };
  process.stdout.write = wrapWrite(origStdoutWrite);
  process.stderr.write = wrapWrite(origStderrWrite);

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

  // Load existing for dedup. L9: when options.tenantId is set on a non-global
  // capture, scope the dedup read so tenant A's captures don't get suppressed
  // by tenant B's existing content. Undefined preserves host-wide behaviour.
  const existing = loadAllEntries(
    targetRoot,
    useGlobal ? undefined : options.tenantId,
  );

  let captured = 0;
  let skipped = 0;
  let rejected = 0;

  // AT1 P2 fix (dry-run parity, docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
  // dry-run used to skip the guarded write branch ENTIRELY, so a tombstoned
  // extraction printed as `[capture]` and counted toward `captured` — the
  // preview lied about what a real run would do. Mirrors importers.ts's
  // importEntries dry-run probe (commit 6146e82): open a read-only handle
  // once, run the same checkRejectionGuard the real write path uses via
  // writeEntry, never write anything.
  const dryRunDb = options.dryRun ? openHippoDb(targetRoot) : null;
  try {
    for (const item of extracted) {
      if (isDuplicate(item.content, existing)) {
        skipped++;
        if (options.dryRun) {
          console.log(`  [skip] (${item.category}) ${item.content.slice(0, 80)}`);
        }
        continue;
      }

      // A3: kind defaults to 'distilled'. capture.ts extracts curated items from
      // session output (not raw transcript chunks), so distilled is correct. If a
      // future variant captures full raw session text, it MUST set kind: 'raw'
      // and route deletions through archiveRawMemory(). See MEMORY_ENVELOPE.md.
      // L9: the dedup read above is scoped by options.tenantId — the WRITE
      // must match, or scoped-dedup-passes-then-default-tenant-write breaks
      // the per-tenant contract. Mirror the dedup-read guard: when
      // global: true, the global store is host-wide and tenant is irrelevant
      // (createMemory's default 'default' applies). When global: false,
      // options.tenantId scopes the write to the same tenant as the dedup.
      const entry = createMemory(item.content, {
        layer: Layer.Episodic,
        tags: item.tags,
        source: 'capture',
        confidence: 'observed',
        tenantId: useGlobal ? undefined : options.tenantId,
      });

      if (options.dryRun) {
        if (dryRunDb) {
          try {
            checkRejectionGuard(dryRunDb, entry.tenantId ?? 'default', entry.id, entry.content);
          } catch (err) {
            if (err instanceof RejectedValueError) {
              rejected++;
              console.log(`  [reject] (${item.category}) ${item.content.slice(0, 80)} - matches a rejected value`);
              continue;
            }
            throw err;
          }
        }
        console.log(`  [capture] (${item.category}) ${item.content}`);
      } else {
        // AT1 (plan §3 containment): one rejected item must not abort the
        // rest of this capture's items.
        try {
          writeEntry(targetRoot, entry);
        } catch (err) {
          if (err instanceof RejectedValueError) {
            rejected++;
            continue;
          }
          throw err;
        }
        updateStats(targetRoot, { remembered: 1 });
        existing.push(entry); // within-batch dedup

        if (isEmbeddingConfigured(targetRoot)) {
          embedMemory(targetRoot, entry).catch(() => {});
        }
      }

      captured++;
    }
  } finally {
    if (dryRunDb) closeHippoDb(dryRunDb);
  }

  const prefix = options.dryRun ? '[dry-run] ' : '';
  const globalPrefix = useGlobal ? '[global] ' : '';
  console.log(
    `\n${prefix}${globalPrefix}Captured ${captured} items (${skipped} skipped as duplicates` +
      (rejected > 0 ? `, ${rejected} rejected` : '') +
      ')'
  );
}

// ---------------------------------------------------------------------------
// `hippo pre-compact` — PreCompact hook producer
// ---------------------------------------------------------------------------

/** Never read the whole transcript — PreCompact fires exactly when it's largest. */
export const PRE_COMPACT_TAIL_BYTES = 256 * 1024;

export const PRE_COMPACT_TASK_CAP = 200;
export const PRE_COMPACT_SUMMARY_CAP = 2000;
export const PRE_COMPACT_NEXT_STEP_CAP = 500;

/**
 * Truncate `text` to at most `maxChars` UTF-16 code units without splitting
 * a surrogate pair at the boundary. A plain `slice(0, n)` can land between a
 * high and low surrogate, leaving an unpaired surrogate in a stored/
 * re-injected snapshot field. If the code unit at the cut point is a high
 * surrogate (0xD800-0xDBFF), back off one unit so the pair stays whole.
 */
export function truncateCodePointSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Cap from the RECENT end: summariseTranscript emits user turns oldest-to-
 * newest with assistant responses after them, so a head-first cap keeps
 * stale context and drops exactly the newest working state this feature
 * exists to preserve. Keep the LAST maxChars instead, aligned forward to a
 * nearby line start, with a trim marker (codex round 3).
 */
export function truncateKeepNewest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // never start on a low surrogate
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < text.length && nl - start < 200) start = nl + 1;
  return '[...earlier turns trimmed]\n' + text.slice(start);
}

/**
 * Positional read of the last `capBytes` of `transcriptPath`, aligned
 * forward to the first complete JSONL line. Uses fs.openSync/readSync at a
 * byte offset rather than reading the whole file and slicing — PreCompact
 * fires exactly when transcripts are largest, so a whole-file read is the
 * one thing this path cannot do.
 *
 * Boundary handling (X14): a seek that lands mid-line must drop that
 * partial first line so every remaining line parses as complete JSON. A
 * seek that lands exactly after a '\n' already starts on a complete line
 * and must NOT drop it — doing so would silently discard one whole line on
 * every tail read whose start offset happens to align with a line break.
 * Distinguished by peeking at the single byte immediately before `start`.
 */
export function readTranscriptTail(transcriptPath: string, capBytes: number = PRE_COMPACT_TAIL_BYTES): string {
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - capBytes);
  const length = size - start;
  if (length <= 0) return '';

  const fd = fs.openSync(transcriptPath, 'r');
  try {
    let onLineBoundary = start === 0;
    if (!onLineBoundary) {
      const prevByte = Buffer.alloc(1);
      fs.readSync(fd, prevByte, 0, 1, start - 1);
      onLineBoundary = prevByte[0] === 0x0a; // '\n'
    }

    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (!onLineBoundary) {
      // Landed mid-line — drop the partial first line so every remaining
      // line parses as complete JSON.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Most recent plain-text user message in a JSONL tail. Claude Code transcript shape only (PreCompact is claude-code-only). */
function lastPlainUserMessage(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry) || entry.type !== 'user') continue;
    // Meta/sidechain lines carry type:'user' but are not the human: after a
    // FIRST compaction the transcript holds the compact summary as an isMeta
    // user line, and sub-agent turns are isSidechain — deriving "task" from
    // either yields junk on every later compaction.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const content = 'content' in message ? message.content : undefined;
    if (isStringValue(content) && content.trim()) return content.trim();
  }
  return '';
}

/** Last assistant text block in a JSONL tail (skips thinking + tool_use, same as summariseTranscript). */
function lastAssistantTextBlock(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry) || entry.type !== 'assistant') continue;
    // Same meta/sidechain guard as lastPlainUserMessage: sub-agent turns
    // (isSidechain) are not this session's next step.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const content = 'content' in message ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (isObjectLike(block)) {
        const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
        if (isStringValue(blockText) && blockText.trim()) {
          return blockText.trim();
        }
      }
    }
  }
  return '';
}

// Diagnostic-only log; a long-lived install must not grow it unbounded.
const PRE_COMPACT_LOG_MAX_BYTES = 256 * 1024;

/**
 * Log-forgery guard: messages here interpolate payload-controlled values
 * (transcript paths, session ids). Strip C0 control chars — newlines above
 * all — so a crafted value can't inject fake `[hippo] ...` log lines.
 * Exported for every `[hippo]`-prefixed log writer that interpolates
 * payload-controlled values (cli.ts appendSessionEndCloseLog) — one shared
 * guard, not per-file copies.
 */
export function sanitizeLogMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\x00-\x1f]/g, '');
}

function appendPreCompactLog(logFile: string, message: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (stat && stat.size > PRE_COMPACT_LOG_MAX_BYTES) {
      fs.writeFileSync(logFile, '', 'utf8'); // start fresh — dumb cap, no rotation
    }
    fs.appendFileSync(logFile, `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`, 'utf8');
  } catch {
    // Diagnostic-only; a log write failure must never affect the exit-0 contract.
  }
}

/** True iff `filePath` exists and is readable — checks both in one call. */
function isReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the PreCompact producer. Returns any `embedMemory` promises kicked
 * off along the way (empty on every skip path) so `cmdPreCompact` can await
 * them, bounded, before it exits (X6).
 */
function runPreCompact(hippoRoot: string, stdinText: string | undefined, logFile: string): Promise<unknown>[] {
  // X3: the PreCompact hook fires in every Claude Code project, including
  // ones that never ran `hippo init`. Gate on the non-exiting isInitialized
  // check BEFORE any store-opening call (saveActiveTaskSnapshot etc. all
  // call initStore internally, which would silently create a store here).
  if (!isInitialized(hippoRoot)) {
    appendPreCompactLog(logFile, 'skip: store not initialized');
    return [];
  }

  // A true manual invocation has no stdin at all (TTY, or a non-TTY pipe
  // that yielded an empty read) — that's the ONLY case newest-transcript
  // auto-discovery is allowed to run. Any other non-empty stdin must
  // JSON-parse to an object carrying a string transcript_path, or it is
  // treated as malformed input and skipped (X4) rather than silently
  // falling back to discovery, which could snapshot an unrelated session's
  // transcript under this payload's session_id.
  const manualInvocation = !stdinText || stdinText.trim() === '';
  let sessionId: string | null = null;
  let payloadTranscriptPath: string | null = null;

  if (!manualInvocation) {
    let payload: unknown;
    try {
      payload = JSON.parse(stdinText!.trim());
    } catch {
      // payload stays undefined; the isObjectLike check below rejects it
      // the same way it would reject an explicit null.
    }
    if (!isObjectLike(payload) || !('transcript_path' in payload) || !isStringValue(payload.transcript_path)) {
      // Covers non-JSON stdin, a JSON value that isn't an object, and
      // `"transcript_path": null` (or the key missing entirely) — all fail
      // the string check. Log and skip; never fall through to auto-discovery.
      appendPreCompactLog(logFile, 'skip: malformed or incomplete PreCompact payload (missing string transcript_path)');
      return [];
    }
    if ('session_id' in payload && isStringValue(payload.session_id)) sessionId = payload.session_id;
    payloadTranscriptPath = payload.transcript_path;
  }

  // X11: payload transcript_path must end .jsonl. No directory-containment
  // check is applied on top of this — CLAUDE_CONFIG_DIR can relocate the
  // transcript root entirely, so a path-prefix allowlist would just reject
  // legitimate relocated installs. The trust boundary here is process
  // identity, not path shape: a local process able to feed this hook
  // arbitrary stdin already runs as the same user who owns every transcript
  // this check could gate on, so containment buys no real isolation.
  if (payloadTranscriptPath !== null && !/\.jsonl$/i.test(payloadTranscriptPath)) {
    appendPreCompactLog(logFile, `skip: payload transcript_path is not a .jsonl file: ${payloadTranscriptPath}`);
    return [];
  }

  // A payload transcript_path is EXCLUSIVE: never fall back to
  // newest-transcript auto-discovery when it's missing/unreadable. That
  // fallback would snapshot a DIFFERENT session's transcript under THIS
  // payload's session_id — cross-session contamination with wrong linkage
  // (verify-stage E2E finding, 2026-08-03). Auto-discovery only applies
  // on a true manual invocation (no payload at all).
  let transcriptPath: string | null;
  if (payloadTranscriptPath !== null) {
    if (isReadableFile(payloadTranscriptPath)) {
      transcriptPath = payloadTranscriptPath;
    } else {
      appendPreCompactLog(logFile, `skip: payload transcript_path unreadable: ${payloadTranscriptPath}`);
      return [];
    }
  } else {
    transcriptPath = resolveLastSessionTranscript(undefined, stdinText);
  }

  if (!transcriptPath) {
    appendPreCompactLog(logFile, 'skip: no transcript resolved');
    return [];
  }

  let tail: string;
  try {
    // CX7 (codex round 2): a final JSONL record larger than the window
    // swallows the whole tail — the seek lands inside it and alignment
    // drops everything up to its terminator, which is exactly the shape of
    // a huge tool_result that itself triggered compaction. Grow the window
    // a bounded number of times until at least one complete line survives.
    tail = readTranscriptTail(transcriptPath, PRE_COMPACT_TAIL_BYTES);
    let prevCap = PRE_COMPACT_TAIL_BYTES;
    for (const grownCap of [PRE_COMPACT_TAIL_BYTES * 4, PRE_COMPACT_TAIL_BYTES * 16]) {
      if (tail.trim() !== '') break;
      if (fs.statSync(transcriptPath).size <= prevCap) break; // already read the whole file
      appendPreCompactLog(logFile, `tail window grown to ${grownCap} bytes (oversized final record)`);
      tail = readTranscriptTail(transcriptPath, grownCap);
      prevCap = grownCap;
    }
  } catch (err) {
    appendPreCompactLog(logFile, `skip: could not read transcript tail: ${errorMessage(err)}`);
    return [];
  }

  const summaryFull = summariseTranscript(tail);
  // CX5 (codex round 2): extraction runs over REDACTED text — extracted
  // items become durable memories and must never carry raw secrets any more
  // than the snapshot fields may. (The pre-existing SessionEnd capture path
  // is deliberately unchanged.)
  const scrubbedSummary = redactSecrets(summaryFull);
  const extracted = extractFromText(scrubbedSummary);
  const rawTask = lastPlainUserMessage(tail);
  const rawNextStep = lastAssistantTextBlock(tail);

  // Full skip only when EVERY derived field is empty and nothing was
  // extracted — never clobber a user-authored active snapshot with junk.
  if (!rawTask.trim() && !summaryFull.trim() && !rawNextStep.trim() && extracted.length === 0) {
    appendPreCompactLog(logFile, 'skip: empty summary and no extracted items');
    return [];
  }

  const tenantId = resolveTenantId({});

  // Per-field merge (X1): a tool-heavy tail whose only user turns are
  // tool_result arrays derives an empty task even though the summary is
  // non-empty. Loading the existing snapshot first lets each field fall
  // back independently instead of the whole write clobbering a
  // user-authored field with blank text.
  let existing: TaskSnapshot | null = null;
  try {
    existing = loadActiveTaskSnapshot(hippoRoot, tenantId);
  } catch {
    // No existing snapshot to merge against — proceed with derived-only.
  }

  // X9: scrub secret-shaped substrings out of freshly-derived text before it
  // is capped/stored. These fields bypass the normal capture content gate
  // (they're not extracted items), so this producer is the only place that
  // ever sees them before they land in task_snapshots. Carried-over
  // existing field values are NOT re-scrubbed here — they already passed
  // through this same gate (or were set via `hippo snapshot save`, which is
  // deliberately untouched, same as the caps below).
  const scrubbedTask = redactSecrets(rawTask);
  const scrubbedNextStep = redactSecrets(rawNextStep);

  // CX6 (codex round 2): field fallback must never move content across
  // sessions — session A's task carried into a snapshot saved under session
  // B's id would pass compact-resume's session gate wearing the wrong
  // badge. Fall back only when the existing snapshot has no session, this
  // payload has none, or they match.
  const fallback =
    existing !== null &&
    (existing.session_id === null || sessionId === null || existing.session_id === sessionId)
      ? existing
      : null;

  // Field caps are enforced HERE ONLY — saveActiveTaskSnapshot and the
  // `hippo snapshot save` CLI path stay uncapped (AGENTS.md public-API
  // preservation). Caps protect the re-injection token budget. Code-point
  // safe (X2): never split a surrogate pair at the cut.
  const task = scrubbedTask.trim()
    ? truncateCodePointSafe(scrubbedTask, PRE_COMPACT_TASK_CAP)
    : (fallback?.task ?? '');
  const summary = scrubbedSummary.trim()
    ? truncateKeepNewest(scrubbedSummary, PRE_COMPACT_SUMMARY_CAP)
    : (fallback?.summary ?? '');
  const nextStep = scrubbedNextStep.trim()
    ? truncateCodePointSafe(scrubbedNextStep, PRE_COMPACT_NEXT_STEP_CAP)
    : (fallback?.next_step ?? '');

  // Snapshot writes FIRST: a capture-extraction failure below must never
  // lose the headline artifact. The reverse order would risk it. All-empty
  // fields (cross-session tail with nothing derivable) skip the write so a
  // foreign session's junk never displaces the owning session's snapshot.
  if (!task && !summary && !nextStep) {
    appendPreCompactLog(logFile, 'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)');
  } else {
    try {
      saveActiveTaskSnapshot(hippoRoot, tenantId, {
        task,
        summary,
        next_step: nextStep,
        source: 'pre-compact',
        session_id: sessionId,
      });
      appendPreCompactLog(logFile, 'snapshot saved');
    } catch (err) {
      appendPreCompactLog(logFile, `snapshot save failed: ${errorMessage(err)}`);
    }
  }

  // Capture extraction SECOND, own try/catch: a failure here self-heals at
  // the next SessionEnd capture (existing dedup absorbs the overlap).
  try {
    const { captured, skipped, rejected, embeds } = writeExtractedItems(hippoRoot, tenantId, extracted);
    appendPreCompactLog(
      logFile,
      `capture: ${captured} items captured, ${skipped} skipped` +
        (rejected > 0 ? `, ${rejected} rejected` : ''),
    );
    return embeds;
  } catch (err) {
    appendPreCompactLog(logFile, `capture failed: ${errorMessage(err)}`);
    return [];
  }
}

export interface PreCompactOptions {
  stdinText?: string;
  logFile?: string;
}

// X6: bound how long cmdPreCompact will wait for fire-and-forget embeddings
// to settle before it exits. PreCompact runs under a hook timeout (30s in
// the installer) — 3s leaves ample headroom while still giving embeddings a
// real chance to finish instead of racing process.exit(0) unconditionally.
const EMBED_SETTLE_TIMEOUT_MS = 3000;

/**
 * PreCompact hook entry point. Exit code 2 on PreCompact BLOCKS compaction,
 * so this verb must exit 0 on every path — malformed stdin, missing
 * transcript, and store errors all degrade to a logged no-op rather than a
 * thrown error. Callers (src/cli.ts) must not wrap this in anything that
 * could turn a caught-and-logged failure back into a non-zero exit.
 */
export async function cmdPreCompact(hippoRoot: string, options: PreCompactOptions): Promise<void> {
  const logFile = options.logFile ?? defaultPreCompactLogPath();
  let embeds: Promise<unknown>[] = [];
  try {
    embeds = runPreCompact(hippoRoot, options.stdinText, logFile);
  } catch (err) {
    appendPreCompactLog(logFile, `pre-compact failed: ${errorMessage(err)}`);
  }

  if (embeds.length > 0) {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), EMBED_SETTLE_TIMEOUT_MS);
      timer.unref?.();
    });
    const settled = Promise.allSettled(embeds).then(() => 'settled' as const);
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer!);
    appendPreCompactLog(logFile, outcome === 'settled' ? 'embeddings settled' : 'embeddings timeout');
  }

  process.exit(0);
}
