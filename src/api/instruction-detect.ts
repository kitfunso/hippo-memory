/**
 * Prompt-injection detection for untrusted memory content: a heuristic that patterns can miss,
 * never the boundary. The boundary is the frame every untrusted row prints in
 * (api/context/context-render.ts). Leaf module, no store/api imports.
 */

import { shownText, type LeadInText } from '../base/memory/lead-in.js';

/** What a member's flagged row in a shared scope carries: it is kept, and prints framed as
 * untrusted. */
export const INSTRUCTION_LIKE_TAG = 'instruction-like';

/** What every untrusted write (connector text) carries, so it prints framed whatever the
 * detector said of it. */
export const UNTRUSTED_ORIGIN_TAG = 'untrusted-origin';

/** The tags connector rows written before UNTRUSTED_ORIGIN_TAG carry, so an upgraded store
 * frames them too. */
export const CONNECTOR_SOURCE_TAGS: readonly string[] = ['source:slack', 'source:github'];

/** True for a row that prints framed as untrusted: connector text, or a member row the check
 * flagged. A prompt with no frame of its own keeps such a row's lead-in out. */
export function isUntrustedSource(tags: readonly string[]): boolean {
  return (
    tags.includes(UNTRUSTED_ORIGIN_TAG) ||
    tags.includes(INSTRUCTION_LIKE_TAG) ||
    tags.some((t) => CONNECTOR_SOURCE_TAGS.includes(t))
  );
}

export interface InstructionDetection {
  flagged: boolean;
  reason: string | null;
}

const INSTRUCTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'override-instructions',
    re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above)\b[^.\n]{0,40}\binstructions?\b/i,
  },
  {
    name: 'role-reassignment',
    re: /\b(?:you are now|act as|pretend to be)\b[^.\n]{0,40}\b(?:an?\s+)?(?:ai|assistant|agent|system)\b/i,
  },
  {
    name: 'chat-role-markup',
    re: /<\|im_start\|>|<\|system\|>|\[INST\]|<\/?system>|###\s*system\s*:/i,
  },
  {
    name: 'system-prompt-reference',
    re: new RegExp(
      String.raw`\b(?:(?:override|ignore|bypass|replace|reveal)\b[^.\n]{0,40}\b(?:system prompt|developer message)|` +
        String.raw`(?:system prompt|developer message)\b[^.\n]{0,40}\b(?:override|ignore|bypass|replace|reveal))\b`,
      'i',
    ),
  },
  // "always"/"never" alone (ordinary PR prose) doesn't flag without an agent-facing target nearby
  // too.
  {
    name: 'standing-order',
    re: new RegExp(
      String.raw`\b(?:from now on|whenever you|always|never)\b[^.\n]{0,50}\b(?:you must|` +
        String.raw`(?:the ai|the assistant|the agent|claude|copilot)\s+(?:must|should|will)\b)`,
      'i',
    ),
  },
  {
    name: 'concealment',
    re: /\b(?:do not|never|don't)\b[^.\n]{0,40}\b(?:tell|mention|reveal)\b[^.\n]{0,40}\bthe user\b/i,
  },
  {
    name: 'remote-script-exec',
    re: new RegExp(
      String.raw`\b(?:curl|wget)\b[^\n|]{0,80}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|` +
        String.raw`\biex\s*\(\s*(?:iwr|invoke-webrequest|new-object\s+net\.webclient)`,
      'i',
    ),
  },
  {
    name: 'exfiltration',
    re: new RegExp(
      String.raw`\b(?:send|post|upload|exfiltrate)\b[^.\n]{0,40}\b` +
        String.raw`(?:secrets?|tokens?|api[- ]?keys?|credentials?|env(?:ironment)? variables?)\b`,
      'i',
    ),
  },
  { name: 'unicode-tag-chars', re: /[\u{E0000}-\u{E007F}]/u },
];

// A stray zero-width char has legitimate uses (ZWJ); only a run of 3+ adjacent ones reads as
// smuggling.
const ZERO_WIDTH_RUN_RE = /[\u200B-\u200F\u2060-\u2064]{3,}/;

// Reorders what is drawn without changing a byte a pattern reads, and ordinary right-to-left prose
// never needs one.
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/;

// A renderer draws a reference as the character it names: decimal, hex, or one of the five names
// XML defines.
const CHARACTER_REFERENCE_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

// Tag block stays for unicode-tag-chars; U+2800 draws blank with no property; White_Space stays a separator.
const JOINER_RE =
  /(?![\p{White_Space}\u{E0000}-\u{E007F}])[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800]/gu;

// Controls draw nothing either, so each is read both ways like a joiner; White_Space stays a separator.
const CONTROL_RE = /(?!\p{White_Space})\p{Cc}/gu;

// One reading cannot serve a mark inside a word and a mark between words, so each class is read both ways.
const MARK_READINGS: readonly string[] = ['', ' '];

// Cyrillic, then Greek, letters drawn like a c e i j o p s x y; closed at those, so Russian or
// Greek prose folds into no phrase a pattern names.
const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ['\u0430', 'a'],
  ['\u0441', 'c'],
  ['\u0435', 'e'],
  ['\u0456', 'i'],
  ['\u0458', 'j'],
  ['\u043E', 'o'],
  ['\u0440', 'p'],
  ['\u0455', 's'],
  ['\u0445', 'x'],
  ['\u0443', 'y'],
  ['\u0410', 'A'],
  ['\u0421', 'C'],
  ['\u0415', 'E'],
  ['\u0406', 'I'],
  ['\u0408', 'J'],
  ['\u041E', 'O'],
  ['\u0420', 'P'],
  ['\u0405', 'S'],
  ['\u0425', 'X'],
  ['\u0423', 'Y'],
  ['\u03B1', 'a'],
  ['\u03B5', 'e'],
  ['\u03B9', 'i'],
  ['\u03F3', 'j'],
  ['\u03BF', 'o'],
  ['\u03C1', 'p'],
  ['\u03C7', 'x'],
  ['\u03B3', 'y'],
  ['\u0391', 'A'],
  ['\u0395', 'E'],
  ['\u0399', 'I'],
  ['\u037F', 'J'],
  ['\u039F', 'O'],
  ['\u03A1', 'P'],
  ['\u03A7', 'X'],
  ['\u03A5', 'Y'],
]);
const GREEK_OR_CYRILLIC_RE = /[\u0370-\u03FF\u0400-\u04FF]/g;

// A line break stays as the sentence bound the patterns need; by property, so U+0085 folds too.
const SPACE_RUN_RE = /(?:(?!\n)\p{White_Space})+/gu;

function referencedCharacter(
  reference: string,
  decimal?: string,
  hex?: string,
  name?: string,
): string {
  if (name !== undefined) return NAMED_REFERENCES.get(name) ?? reference;
  const code =
    decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
  // NUL, half a surrogate pair and a number past Unicode name no character, so the reference is
  // read as written.
  const drawn = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return drawn ? String.fromCodePoint(code) : reference;
}

type Reading = readonly [joiner: string, control: string];

// Decode references once and fold full-width, mathematical and enclosed letters to plain ones.
function decodedText(text: string): string {
  return text.replace(CHARACTER_REFERENCE_RE, referencedCharacter).normalize('NFKC');
}

/** The readings of every mark class that some text holds; a text with no mark has one. */
function readingsOf(...texts: string[]): Reading[] {
  const joiners = texts.some((t) => t.search(JOINER_RE) >= 0) ? MARK_READINGS : [''];
  const controls = texts.some((t) => t.search(CONTROL_RE) >= 0) ? MARK_READINGS : [''];
  return joiners.flatMap((joiner) => controls.map((control): Reading => [joiner, control]));
}

function readMarks(decoded: string, [joiner, control]: Reading): string {
  return decoded
    .replace(JOINER_RE, joiner)
    .replace(CONTROL_RE, control)
    .replace(GREEK_OR_CYRILLIC_RE, (letter) => LOOKALIKES.get(letter) ?? letter)
    .replace(SPACE_RUN_RE, ' ');
}

/** `content` as a reader or a model takes it in, once for each reading of its hidden marks. For
 * matching only: what is stored is never this. */
function screeningForms(content: string): string[] {
  const decoded = decodedText(content);
  return [...new Set(readingsOf(decoded).map((reading) => readMarks(decoded, reading)))];
}

function matchedPattern(text: string): string | null {
  for (const { name, re } of INSTRUCTION_PATTERNS) {
    if (re.test(text)) return `pattern:${name}`;
  }
  return null;
}

export function detectInstruction(content: string): InstructionDetection {
  // The text as written goes first: a phrase in plain sight is named before any smuggling rule, and
  // the screened forms only add flags.
  const plain = matchedPattern(content);
  if (plain !== null) return { flagged: true, reason: plain };
  if (ZERO_WIDTH_RUN_RE.test(content)) {
    return { flagged: true, reason: 'pattern:zero-width-smuggling' };
  }
  for (const screened of screeningForms(content)) {
    const disguised = screened === content ? null : matchedPattern(screened);
    if (disguised !== null) return { flagged: true, reason: disguised };
  }
  if (BIDI_CONTROL_RE.test(content)) return { flagged: true, reason: 'pattern:bidi-control' };
  return { flagged: false, reason: null };
}

// One class, tested a code point at a time: a `+` run backtracks and a UTF-16 unit misses an astral mark.
const BLANK_CHAR_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\u2800]/u;

function withoutBlankEnd(text: string): string {
  let end = text.length;
  while (end > 0) {
    const pair =
      end >= 2 &&
      isLowSurrogate(text.charCodeAt(end - 1)) &&
      isHighSurrogate(text.charCodeAt(end - 2));
    const from = pair ? end - 2 : end - 1;
    if (!BLANK_CHAR_RE.test(text.slice(from, end))) break;
    end = from;
  }
  return text.slice(0, end);
}

function withoutBlankStart(text: string): string {
  let start = 0;
  while (start < text.length) {
    const to = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
    if (!BLANK_CHAR_RE.test(text.slice(start, to))) break;
    start = to;
  }
  return text.slice(start);
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The lead-in joined to the content by a space and by nothing, blanks cut at the join. */
function joinedForms(leadIn: string, content: string): string[] {
  const lead = withoutBlankEnd(leadIn);
  const body = withoutBlankStart(content);
  return [`${lead} ${body}`, `${lead}${body}`];
}

/** Matches the screened lead-in and content across the join under one reading, with no second decode. */
function screenedJoinPattern(leadIn: string, content: string): string | null {
  const lead = decodedText(leadIn);
  const body = decodedText(content);
  for (const reading of readingsOf(lead, body)) {
    const head = withoutBlankEnd(readMarks(lead, reading));
    const tail = withoutBlankStart(readMarks(body, reading));
    const found = matchedPattern(`${head} ${tail}`) ?? matchedPattern(`${head}${tail}`);
    if (found !== null) return found;
  }
  return null;
}

/** Screens the text as shown, then the lead-in joined to the content by a space and by nothing,
 * as written and then screened part by part. First flag wins; a heading-style lead-in can flag plain
 * content into a hold, never a lost write. */
export function detectInstructionIn(text: LeadInText): InstructionDetection {
  const shown = detectInstruction(shownText(text));
  if (shown.flagged || !text.leadIn) return shown;
  for (const joined of joinedForms(text.leadIn, text.content)) {
    const found = detectInstruction(joined);
    if (found.flagged) return found;
  }
  const reason = screenedJoinPattern(text.leadIn, text.content);
  return reason === null ? shown : { flagged: true, reason };
}
