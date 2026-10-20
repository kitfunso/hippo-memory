// Which sentences of a session's final reply carry a lesson, and the digest text built from them. No file or store
// access: surface/capture/session-digest.ts reads the transcript, probes the paths and writes the row.
import { USER_SEGMENT } from '../../base/util/home-path.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';

/** Five-word runs are stock phrases; six in a row is a copied clause. */
export const ECHO_WINDOW = 6;
/** Five sentences of about 150 chars leave room for the Changed line inside the total cap. */
export const MAX_SENTENCES = 5;
/** A longer "sentence" in agent text is an unsplit list or pasted output. */
export const MAX_SENTENCE_CHARS = 300;
/** At about 20 chars per repo path this keeps the Changed line near 50 tokens. */
export const MAX_FILES = 10;
/** 300 tokens at 4 chars each: 20% of the 1500-token default budget of both context surfaces. */
const MAX_DIGEST_CHARS = 1200;

const ABSOLUTE_PATH = /(?<![\w.~/\\:-])(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\/)[^\s`'"<>|*?()[\]{},;]+/g;

function rewriteRepoPaths(sentence: string, relativePath: (absolute: string) => string | null): string {
  return sentence.replace(ABSOLUTE_PATH, (token) => {
    const trail = /[.:!]+$/.exec(token)?.[0] ?? '';
    const rel = relativePath(token.slice(0, token.length - trail.length));
    return rel === null ? token : (rel || '.') + trail;
  });
}

/** Each opener points back to something named before the sentence; There, I, We and You do not. */
const OPENERS = new Set([
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'they',
  'them',
  'their',
  'he',
  'she',
  'his',
  'her',
  'here',
  'both',
  'each',
  'either',
  'neither',
  'such',
  'which',
]);
const COUNTED_OPENER = /^(?:all|the|these|those|both)\s+\d/i;

/** Each anchor names a place in the code a later task can search for. */
const ANCHORS: readonly RegExp[] = [
  /`[^`]+`/,
  /\S[\\/]\S/,
  /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/,
  /\b[A-Za-z_]\w*\(\)/,
  /(?:^|\s)--[a-z][\w-]*/,
  /(?:^|\s)#\d+\b/,
];
/** Each marker states a cause or a choice, the part of a lesson that transfers. */
const MARKERS = new RegExp(
  '\\b(?:because|caused by|due to|root cause|the (?:bug|issue|problem) was|fail(?:s|ed) when|so that|otherwise|' +
    'instead of|rather than|switched to|decided|chose|must|never|always|do not)\\b',
  'i',
);

const FENCE = /^\s*(`{3,}|~{3,})/;
const STRUCTURE_LINE = /^\s*(?:#{1,6}\s|\||>|([-*_])(?:\s*\1){2,}\s*$)/;
const PROTECTED = /`[^`\n]+`|\b(?:e\.g|i\.e)\./gi;

/** Prose lines of a markdown reply: code, headings, tables, quotes and rules are not sentences. */
function proseText(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const mark = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (STRUCTURE_LINE.test(line)) continue;
    kept.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1'));
  }
  return kept.join('\n');
}

/** Sentences of the reply; code spans and "e.g." are held out of the split so their dots never end a sentence. */
export function digestSentences(text: string): string[] {
  const held: string[] = [];
  const masked = proseText(text).replace(PROTECTED, (m) => `\uE000${held.push(m) - 1}\uE001`);
  return masked
    .split(/(?<=[.!?])\s+|\n/)
    .filter((s) => s.trim().length > 5)
    .map((s) => s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => held[Number(i)]).trim())
    .filter(Boolean);
}

function echoTokens(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}

function echoWindows(texts: readonly string[]): Set<string> {
  const windows = new Set<string>();
  for (const text of texts) {
    const tokens = echoTokens(text);
    for (let i = 0; i + ECHO_WINDOW <= tokens.length; i++) windows.add(tokens.slice(i, i + ECHO_WINDOW).join(' '));
  }
  return windows;
}

function echoes(sentence: string, windows: ReadonlySet<string>): boolean {
  const tokens = echoTokens(sentence);
  for (let i = 0; i + ECHO_WINDOW <= tokens.length; i++) {
    if (windows.has(tokens.slice(i, i + ECHO_WINDOW).join(' '))) return true;
  }
  return false;
}

function opensOnReferent(sentence: string): boolean {
  const head = sentence.replace(/^[^\p{L}\p{N}]+/u, '');
  const word = /^\p{L}+/u.exec(head)?.[0].toLowerCase() ?? '';
  return OPENERS.has(word) || COUNTED_OPENER.test(head);
}

export function sentenceScore(sentence: string): number {
  const plain = sentence.replace(/\b(?:e\.g|i\.e)\./gi, '');
  return (ANCHORS.some((re) => re.test(plain)) ? 1 : 0) + (MARKERS.test(plain) ? 1 : 0);
}

interface Candidate {
  index: number;
  text: string;
  score: number;
}

/** Surviving sentences, best first: anchored or reasoned ones rank above the rest, earlier wins a tie. */
function rankedSentences(
  finalText: string,
  windows: ReadonlySet<string>,
  relativePath: (absolute: string) => string | null,
): Candidate[] {
  const kept: Candidate[] = [];
  // Redact the whole reply before splitting and capping, so a secret is never cut into pieces that no pattern matches.
  digestSentences(maskEmails(redactSecretsStrict(finalText))).forEach((sentence, index) => {
    if (/[?:]$/.test(sentence) || opensOnReferent(sentence) || echoes(sentence, windows)) return;
    const text = rewriteRepoPaths(sentence, relativePath);
    // A home-directory path names its user and the store may be shared, so such a sentence is dropped.
    if (text.length > MAX_SENTENCE_CHARS || USER_SEGMENT.some((re) => re.test(text))) return;
    kept.push({ index, text, score: sentenceScore(text) });
  });
  return kept.sort((a, b) => b.score - a.score || a.index - b.index);
}

function changedLine(files: readonly string[]): string {
  for (let shown = Math.min(files.length, MAX_FILES); shown > 0; shown--) {
    const more = files.length - shown;
    const line = maskEmails(
      redactSecretsStrict(`Changed: ${files.slice(0, shown).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`),
    );
    if (line.length <= MAX_DIGEST_CHARS) return line;
  }
  return '';
}

export interface DigestSources {
  finalText: string;
  /** Text the session already holds: its own prompts, and what hippo injected into it. */
  echoTexts: readonly string[];
  /** Repo-relative paths the session changed, first edit first. */
  files: readonly string[];
  /** Repo-relative form of an absolute path, '' for the root, null outside the repo. */
  relativePath: (absolute: string) => string | null;
}

export interface DigestDraft {
  content: string;
  sentences: number;
  files: number;
}

/** The digest text, or null when nothing survives the filters. Sentences print in reply order. */
export function buildSessionDigest(sources: DigestSources): DigestDraft | null {
  const ranked = rankedSentences(sources.finalText, echoWindows(sources.echoTexts), sources.relativePath);
  const changed = changedLine(sources.files);
  // The cap drops whole sentences, lowest-ranked first, and keeps the Changed line.
  for (let kept = ranked.slice(0, MAX_SENTENCES); ; kept = kept.slice(0, -1)) {
    const lines = [...kept].sort((a, b) => a.index - b.index).map((c) => c.text);
    const content = [...lines, changed].filter(Boolean).join('\n');
    if (content.length > MAX_DIGEST_CHARS && kept.length > 0) continue;
    return content ? { content, sentences: kept.length, files: sources.files.length } : null;
  }
}
