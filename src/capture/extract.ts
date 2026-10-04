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

export function splitSentences(text: string): string[] {
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
function isLetterOrDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function lastCloserIndex(full: string): number {
  // ONE pass, not one per apostrophe. The previous shape rescanned the whole
  // remaining suffix at every boundary apostrophe, so a transcript full of
  // elisions ("keep 'em", "wait 'til", ...) made extraction quadratic and
  // could stall a moderately sized capture. Codex P2, r7.
  //
  // A quote CLOSES THE SIDE IT IS TIGHT AGAINST. The test needs both
  // neighbours, and one round proved that empirically: these two have the
  // same following character and opposite roles -
  //   "preserve 'a, b'-style"   next '-'  -> CLOSER, content on the left
  //   "then run '--force,"      next '-'  -> OPENER, content on the right
  // so no forward-only rule can separate them. An earlier revision tried
  // exactly that and broke in both directions at once (codex P1+P2, r10):
  // it missed closers before token-joining punctuation and accepted
  // "'.env" as a closer because a dot happened to be in its class.
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
    // pair across the clause boundary. Codex P2, r11.
    const tightBefore = prev !== undefined && !/[\s([{]/.test(prev);
    const endsAfter = next === undefined || /\s/.test(next);
    // Punctuation splits in two, and this is the fact the last three
    // revisions kept rediscovering piecemeal:
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
      // Closing uses the SAME shape test as opening. This was asymmetric:
      // twelve rounds went into deciding when a quote OPENS a literal, while
      // the close accepted any bare "'" - so the apostrophe in a possessive
      // INSIDE a literal closed it early:
      //   "Always pass 'user's a, b list' to the parser."
      //     -> "Always pass 'user's a"   (master kept the whole literal)
      // a mid-literal fragment that then PASSES the write gate, which is
      // precisely the defect this branch exists to remove. Found by the
      // ship-gate review after every earlier gate missed it.
      if (ch === quote && (quote !== "'" || !isLetterOrDigit(full[i + 1]))) {
        quote = null;
      }
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
        // ONLY colon-terminated labels are dropped. Dropping "the X is/was"
        // too left the residue starting with "to ", which isFragment then
        // rejected outright - so "The plan is to ship on Friday" and "The fix
        // was to bump the pool timeout" stored NOTHING, where every prior
        // version stored them. Silent loss on two of the highest-traffic
        // patterns, and invisible: an absent memory leaves no trace. The AT1
        // rejected-value evidence only ever involved colon labels
        // ("decision: "), so the narrower rule keeps that guarantee.
        const isLabelPrefix = /:\s*$/.test(rawPrefix);
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
