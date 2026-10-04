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

import { duplicateKey } from '../same-text.js';
import { isContentWorthStoring } from '../audit.js';

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
// Each pattern carries TWO capture groups: group 1 is the discriminating keyword (plus its
// trailing separator, verbatim), group 2 the content after it, so a negation like "never" survives
// ("Never use X" must not store as "use X"). `extractFromPatterns` joins group1 + a clause-bounded
// group2 (`boundToClause`), so group 2 may reach {1,500}. The keyword keeps its own group because
// keywords like "error:" end in a colon that is not a prose clause boundary.
// `PREFERENCE_PATTERNS[0]` is the exception: its two groups are the content spans either side of
// "instead of"/"over"/"not"; left as-is.
const DECISION_PATTERNS = [
  /(?:we(?:'ve| have)?|i(?:'ve| have)?|let's)\s+(decid(?:ed|e)\s+(?:to\s+)?)(.{1,500})/i,
  /(?:let's|we(?:'ll| will| should)?)\s+((?:go with|do|use|try|build|implement|switch to)\s+)(.{1,500})/i,
  /((?:going|went)\s+with\s+)(.{1,500})/i,
  /((?:the plan is|plan:)\s+)(.{1,500})/i,
  /(decision:\s*)(.{1,500})/i,
];

const RULE_PATTERNS = [
  /\b((?:never|always|must(?:\s+not)?|do(?:n't| not)\s+ever)\s+)(.{1,500})/i,
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

// PREFERENCE_PATTERNS[0] keeps its match[1]-only, unbounded shape; extractFromPatterns
// checks for this exact array element.
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

export function splitSentences(text: string): string[] {
  // Split on sentence boundaries, keeping reasonable chunks
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

function isLetterOrDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** The last plausible CLOSING single quote, or -1. Mirror of the opener rule in `boundToClause`: a closer sits tight
 * against its literal and is never followed by a letter, which is what makes "user's" an apostrophe. */
function lastCloserIndex(full: string): number {
  // ONE pass, not one per apostrophe: a rescan per apostrophe goes quadratic
  // on a transcript full of elisions ("keep 'em", "wait 'til", ...).
  //
  // A quote CLOSES THE SIDE IT IS TIGHT AGAINST, so the test needs both
  // neighbours: these two have the same following character and opposite roles -
  //   "preserve 'a, b'-style"   next '-'  -> CLOSER, content on the left
  //   "then run '--force,"      next '-'  -> OPENER, content on the right
  // so no forward-only rule can separate them.
  //
  //   never a closer   next is a letter/digit      "user's", "keep 'em"
  //   closer           prev is non-whitespace      "'a, b' to", "'a, b'-style"
  //   closer           next is whitespace or end   "preserve 'a, b ' exactly"
  //   closer           next is clause punctuation  "preserve 'a, b ', then"
  //                    that itself ends the token
  //
  // The last clause is what separates ", " from ".env": a dot followed by a
  // letter joins a filename, a dot followed by space ends a sentence.
  for (let j = full.length - 1; j >= 0; j--) {
    if (full[j] !== "'") continue;
    const prev = full[j - 1];
    const next = full[j + 1];
    if (isLetterOrDigit(next)) continue;
    // "tight against content" excludes an OPENING delimiter: in
    // "call parse('--force" the paren is non-whitespace but the quote after
    // it is an opener, and treating it as a closer let an earlier elision
    // pair across the clause boundary.
    const tightBefore = prev !== undefined && !/[\s([{]/.test(prev);
    const endsAfter = next === undefined || /\s/.test(next);
    // Punctuation splits in two:
    //   , ; : ! ? ) ] }  never join tokens - they end the literal whatever
    //                    follows, so "'echo a, b ';then" closes at the ;
    //   . - _ / @ #      DO join tokens - "'.env" and "'--force" continue a
    //                    filename or flag, so these only close when trailed
    //                    by whitespace
    const afterNext = full[j + 2];
    const closesRegardless = next !== undefined && /[,;:!?)\]}]/.test(next);
    const joinerThenSpace =
      next !== undefined && /[.\-_/@#]/.test(next) &&
      (afterNext === undefined || /\s/.test(afterNext));
    if (tightBefore || endsAfter || closesRegardless || joinerThenSpace) return j;
  }
  return -1;
}

/** Cuts `full` (keyword + content) at the first prose `,;:` or `[.!?]` followed by whitespace, scanning from `searchFrom` so a keyword's
 * own colon never counts; the whitespace rule keeps `.env` whole and `maxLen` truncates a long span the 500-char gate would drop. */
function boundToClause(full: string, searchFrom: number, maxLen = 200): string {
  // Depth-awareness matters because memories are full of code; a naive scan cuts
  //   "Always call build(x, y) before deploy."  ->  "Always call build(x"
  // and the fragment PASSES the write gate, since code punctuation reads as "specific".
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
      if (closesQuote(full, i, quote)) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === "'") {
      if (opensSingleQuote(full, i, lastCloser)) { quote = ch; }
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

function closesQuote(full: string, i: number, quote: string): boolean {
  // Closing uses the SAME shape test as opening, else a possessive INSIDE a literal closes it early:
  //   "Always pass 'user's a, b list' to the parser."  ->  "Always pass 'user's a"
  return full[i] === quote && (quote !== "'" || !isLetterOrDigit(full[i + 1]));
}

function opensSingleQuote(full: string, i: number, lastCloser: number): boolean {
  // Quote handling has to tell an APOSTROPHE from a single-quoted
  // LITERAL, because getting either wrong reintroduces the fragment
  // defect this change exists to remove, and both fragments PASS the
  // write gate (code punctuation reads as "specific"):
  //   treat every ' as a quote  -> "Always ensure it's enabled, then
  //     restart..." never leaves quote mode, bounding disabled entirely
  //   treat no ' as a quote     -> "Always pass 'a, b' to the parser."
  //     cuts at the comma and stores "Always pass 'a"
  //
  // Discriminator: a ' OPENS a literal only at a word boundary - preceded
  // by start/whitespace/open-bracket AND followed by non-whitespace. An
  // in-word apostrophe ("it's", "user's") has letters on both sides and is
  // just a character.
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
  // an elided form simply has no partner.
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
  // a letter) after. "user's" fails it on both counts.
  return atBoundary && lastCloser > i;
}

function cleanExtract(raw: string): string {
  let content = raw
    .replace(/^[:\s-]+/, '')
    .replace(/[.!?,;:\s]+$/, '')
    .trim();

  // Trailing cleanup: clause-bounding can cut inside a parenthetical and
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

/** The 500-char write gate minus the 200-char bound counted from the keyword. */
const RULE_LEAD_CAP = 300;

/** A modal rule keeps its subject ("We must never ..."); null keeps the keyword-start form when the lead is long or the keyword sits inside a bracket. */
function ruleLead(sentence: string, keywordStart: number, contentStart: number): string | null {
  if (keywordStart < 0 || contentStart < 0 || contentStart > RULE_LEAD_CAP) return null;
  let depth = 0;
  for (const ch of sentence.slice(0, keywordStart)) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
  }
  return depth > 0 ? null : sentence.slice(0, contentStart);
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
        // PREFERENCE_PATTERNS[0] skips clause-bounding (see comment at its definition).
        bounded = match[1] ?? match[0];
      } else {
        // group1 = keyword + separator (verbatim, never clause-bounded);
        // group2 = the content that follows it (clause-bounded below).
        //
        // The keyword is kept only when it carries SEMANTIC SIGN, a
        // negation or modality ("never", "must not", "do not ever",
        // "always"), because dropping those inverts the meaning. A LABEL keyword ("decision:", "rule:", "error:",
        // "important:") carries no sign: it only names the category, which
        // is already recorded in `category`/`tags`, so prefixing it onto the
        // content is duplication that also breaks value-keyed matching
        // (the rejected-value digest hashes the bare content).
        // Discriminator: a label ends in its own colon, or is a "the X is"
        // phrase.
        const rawPrefix = match[1] ?? '';
        // ONLY colon-terminated labels are dropped: dropping "the X is/was" leaves a residue starting
        // with "to ", which isFragment rejects, so "The plan is to ship on Friday" would store nothing.
        const isLabelPrefix = /:\s*$/.test(rawPrefix);
        const keywordPrefix = isLabelPrefix ? '' : rawPrefix;
        // Scan the UNTRUNCATED remainder, not match[2]: a quoted literal whose closer sits past the
        // 500-char group cap would read as prose; boundToClause caps its OUTPUT, so this costs nothing.
        // Group 2's REAL offset from the regex engine: DECISION_PATTERNS carry an uncaptured subject
        // ("we ", "let's ") ahead of group 1, so `match.index + rawPrefix.length` lands inside the keyword.
        const contentStart = match.indices?.[2]?.[0] ?? -1;
        const afterKeyword = contentStart >= 0 ? sentence.slice(contentStart) : (match[2] ?? match[0]);
        const keywordStart = match.indices?.[1]?.[0] ?? -1;
        const lead = pat === RULE_PATTERNS[0] ? ruleLead(sentence, keywordStart, contentStart) : null;
        bounded = lead !== null
          ? boundToClause(lead + afterKeyword, lead.length, keywordStart + 200)
          : boundToClause(keywordPrefix + afterKeyword, keywordPrefix.length);
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
    const norm = duplicateKey(item.content);
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
