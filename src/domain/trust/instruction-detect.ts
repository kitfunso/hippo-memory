/**
 * Prompt-injection detection for untrusted memory content: a heuristic that patterns can miss,
 * never the boundary. The boundary is the frame every untrusted row prints in
 * (api/context/context-render.ts). Leaf module, no store/api imports.
 */

import { shownText, type LeadInText } from '../../base/memory/lead-in.js';

/** What a member's flagged row in a shared scope carries: held for review on a store that reviews, else kept;
 * either way it prints framed. */
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

// `needs` is a phrase every match holds: a text without it skips a pattern that backtracks long on a repeated keyword.
interface InstructionPattern {
  name: string;
  re: RegExp;
  needs?: RegExp;
}

const INSTRUCTION_PATTERNS: readonly InstructionPattern[] = [
  {
    name: 'override-instructions',
    re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above)\b[^.\n]{0,40}\binstructions?\b/i,
    needs: /instruction/i,
  },
  {
    name: 'role-reassignment',
    re: /\b(?:you are now|act as|pretend to be)\b[^.\n]{0,40}\b(?:an?\s+)?(?:ai|assistant|agent|system)\b/i,
    needs: /you are now|act as|pretend to be/i,
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
    needs: /system prompt|developer message/i,
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
    needs: /from now on|whenever you|always|never/i,
  },
  {
    name: 'concealment',
    re: /\b(?:do not|never|don't)\b[^.\n]{0,40}\b(?:tell|mention|reveal)\b[^.\n]{0,40}\bthe user\b/i,
    needs: /the user/i,
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
    needs: /secret|token|api|credential|env/i,
  },
  { name: 'unicode-tag-chars', re: /[\u{E0000}-\u{E007F}]/u },
];

// A stray zero-width char has legitimate uses (ZWJ); only a run of 3+ adjacent ones reads as
// smuggling.
const ZERO_WIDTH_RUN_RE = /[\u200B-\u200F\u2060-\u2064]{3,}/;

// Reorders what is drawn without changing a byte a pattern reads, and ordinary right-to-left prose
// never needs one.
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/;

// One placeholder for every hidden mark: a noncharacter, so no word, no space, and NFKC keeps it.
const MARK = '\uFDD0';
const MARK_SOURCE = String.raw`\uFDD0`;

// HTML reads every digit of a numeric reference; the bound on a name keeps the scan linear.
const CHARACTER_REFERENCE_RE =
  /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]{0,31});|(nbsp|shy))/g;
const LEADING_ZEROS_RE = /^0+/;
const MAX_REFERENCE_DIGITS = 7;
// The spellings the screen has always decoded: a semicolon, up to 7 decimal or 6 hex digits, or an XML name.
const STRICT_DECIMAL_DIGITS = 7;
const STRICT_HEX_DIGITS = 6;
// One class, tested a code point at a time: a `+` run backtracks and a UTF-16 unit misses an astral mark.
const BLANK_CHAR_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\u2800]/u;
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);
// The WHATWG names whose characters are all White_Space, Default_Ignorable, Cf or Cc.
const BLANK_REFERENCES: ReadonlyMap<string, string> = new Map([
  ['ApplyFunction', '\u2061'],
  ['InvisibleComma', '\u2063'],
  ['InvisibleTimes', '\u2062'],
  ['MediumSpace', '\u205F'],
  ['NegativeMediumSpace', '\u200B'],
  ['NegativeThickSpace', '\u200B'],
  ['NegativeThinSpace', '\u200B'],
  ['NegativeVeryThinSpace', '\u200B'],
  ['NewLine', MARK],
  ['NoBreak', '\u2060'],
  ['NonBreakingSpace', '\u00A0'],
  ['Tab', '\t'],
  ['ThickSpace', '\u205F\u200A'],
  ['ThinSpace', '\u2009'],
  ['VeryThinSpace', '\u200A'],
  ['ZeroWidthSpace', '\u200B'],
  ['af', '\u2061'],
  ['emsp13', '\u2004'],
  ['emsp14', '\u2005'],
  ['emsp', '\u2003'],
  ['ensp', '\u2002'],
  ['hairsp', '\u200A'],
  ['ic', '\u2063'],
  ['it', '\u2062'],
  ['lrm', '\u200E'],
  ['nbsp', '\u00A0'],
  ['numsp', '\u2007'],
  ['puncsp', '\u2008'],
  ['rlm', '\u200F'],
  ['shy', '\u00AD'],
  ['thinsp', '\u2009'],
  ['zwj', '\u200D'],
  ['zwnj', '\u200C'],
]);
// HTML's longest-prefix rule reads these from the head of a longer name; no other WHATWG name starts with either.
const LEGACY_PREFIXES: ReadonlyMap<string, string> = new Map([
  ['nbsp', '\u00A0'],
  ['shy', '\u00AD'],
]);

// A run at a time, so a mark-heavy text is scanned once; White_Space and the tag block (unicode-tag-chars) stay.
const MARK_RE =
  /(?:(?![\p{White_Space}\u{E0000}-\u{E007F}])[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800\p{Cc}])+/gu;

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

// Plain substitutions, since a callback per run costs seconds on a megabyte of alternating marks.
const MARK_RUN_RE = /\uFDD0{2,}/g;
const MARK_BY_SPACE_RE = /\uFDD0(?= )|(?<= )\uFDD0/g;
const SPACE_PAIR_RE = / {2,}/g;

// A name that is no entry reads by HTML's longest-prefix rule: `&shytions;` is a soft hyphen, then `tions;`.
function prefixedReference(reference: string, name: string): string {
  for (const [prefix, character] of LEGACY_PREFIXES) {
    if (name.startsWith(prefix)) return `${character}${reference.slice(prefix.length + 1)}`;
  }
  return reference;
}

function numberedReference(reference: string, decimal?: string, hex?: string): string {
  const written = decimal ?? hex ?? '';
  const digits = written.replace(LEADING_ZEROS_RE, '');
  const radix = decimal === undefined ? 16 : 10;
  const code =
    digits.length > MAX_REFERENCE_DIGITS ? -1 : digits === '' ? 0 : Number.parseInt(digits, radix);
  // HTML draws U+FFFD for a number with no character, and the mark stands for both readings of it.
  if (!(code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff))) return MARK;
  const character = String.fromCodePoint(code);
  const strict =
    reference.endsWith(';') &&
    written.length <= (radix === 16 ? STRICT_HEX_DIGITS : STRICT_DECIMAL_DIGITS);
  // A wide spelling decodes only to a blank: a visible character could close a bound or gap the raw text leaves open.
  if (!strict && !BLANK_CHAR_RE.test(character)) return reference;
  // A referenced line break stays a mark: read as a break it would shut a gap the raw text leaves open.
  return code === 10 ? MARK : character;
}

function referencedCharacter(
  reference: string,
  decimal?: string,
  hex?: string,
  name?: string,
  legacy?: string,
): string {
  const named = name ?? legacy;
  if (named === undefined) return numberedReference(reference, decimal, hex);
  return (
    NAMED_REFERENCES.get(named) ??
    BLANK_REFERENCES.get(named) ??
    prefixedReference(reference, named)
  );
}

/** `text` as a reader or a model takes it in, each hidden mark one MARK. For matching only. */
function screeningForm(text: string): string {
  return text
    .replace(CHARACTER_REFERENCE_RE, referencedCharacter)
    .normalize('NFKC')
    .replace(MARK_RE, MARK)
    .replace(GREEK_OR_CYRILLIC_RE, (letter) => LOOKALIKES.get(letter) ?? letter)
    .replace(SPACE_RUN_RE, ' ')
    .replace(MARK_RUN_RE, MARK)
    .replace(MARK_BY_SPACE_RE, '')
    .replace(SPACE_PAIR_RE, ' ');
}

type Atom = {
  readonly source: string;
  readonly kind: 'consuming' | 'blank' | 'zero-width' | 'spaced-class';
};

// A word, a mark, then a non-word still bounds the word when the mark is read as nothing.
const BOUNDARY = String.raw`(?:\b|(?<=\w${MARK_SOURCE})(?!\w))`;
const ESCAPABLE = '\\^$.*+?()[]{}|/-';
const QUANTIFIER_RE = /^(?:\{\d+(?:,\d*)?\}|[?*+])\??/;

function unsupported(source: string, at: number): never {
  throw new Error(`markTolerant: unsupported syntax at ${at} in ${source}`);
}

function readQuantifier(source: string, at: number): string {
  return QUANTIFIER_RE.exec(source.slice(at))?.[0] ?? '';
}

function readClass(source: string, at: number): [Atom, number] {
  const negated = source.charAt(at + 1) === '^';
  let close = at + (negated ? 2 : 1);
  let spaced = false;
  while (close < source.length && source.charAt(close) !== ']') {
    spaced ||= source.charAt(close) === ' ' || source.startsWith('\\s', close);
    close += source.charAt(close) === '\\' ? 2 : 1;
  }
  if (close >= source.length) return unsupported(source, at);
  // Only the placeholder after an atom may take a mark, or one mark could be taken two ways.
  const open = source.slice(at, close);
  const kind = spaced && !negated ? 'spaced-class' : 'consuming';
  return [{ source: `${open}${negated ? MARK_SOURCE : ''}]`, kind }, close + 1];
}

function readEscape(source: string, at: number): [Atom, number] {
  const next = source.charAt(at + 1);
  if (next === 'b') return [{ source: BOUNDARY, kind: 'zero-width' }, at + 2];
  if (next === 's') return [{ source: String.raw`[\s${MARK_SOURCE}]`, kind: 'blank' }, at + 2];
  if (next !== '' && ESCAPABLE.includes(next)) {
    return [{ source: `\\${next}`, kind: 'consuming' }, at + 2];
  }
  return unsupported(source, at);
}

function readAtom(source: string, at: number): [Atom, number] {
  const ch = source.charAt(at);
  if (ch === '[') return readClass(source, at);
  if (ch === '\\') return readEscape(source, at);
  if (ch === ' ') return [{ source: `[ ${MARK_SOURCE}]`, kind: 'blank' }, at + 1];
  if (ch === '^' || ch === '$') return [{ source: ch, kind: 'zero-width' }, at + 1];
  if (ch > '~' || '.*+?{}()|]'.includes(ch)) return unsupported(source, at);
  return [{ source: ch, kind: 'consuming' }, at + 1];
}

// The placeholder reads as nothing, so only a class that must take a space is lost; an optional one may take none.
function minimumRepeats(quantifier: string): number {
  if (quantifier === '') return 1;
  if (quantifier.startsWith('{')) return Number.parseInt(quantifier.slice(1), 10);
  return quantifier.startsWith('+') ? 1 : 0;
}

function withQuantifier(atom: Atom, quantifier: string): string {
  if (atom.kind === 'zero-width') {
    return quantifier === '' ? atom.source : unsupported(atom.source, 0);
  }
  if (atom.kind === 'blank') return `${atom.source}${quantifier}`;
  if (atom.kind === 'spaced-class' && minimumRepeats(quantifier) > 0) {
    return unsupported(atom.source, 0);
  }
  const marked = `${atom.source}${MARK_SOURCE}?`;
  return quantifier === '' ? marked : `(?:${marked})${quantifier}`;
}

function groupOpener(source: string, at: number): string {
  if (source.startsWith('(?:', at)) return '(?:';
  return source.charAt(at + 1) === '?' ? unsupported(source, at) : '(';
}

function rewriteSequence(source: string, from: number, nested: boolean): [string, number] {
  let out = '';
  let at = from;
  while (at < source.length) {
    const ch = source.charAt(at);
    if (ch === ')') return nested ? [out, at] : unsupported(source, at);
    if (ch === '|') {
      out += ch;
      at += 1;
    } else if (ch === '(') {
      const opener = groupOpener(source, at);
      const [inner, close] = rewriteSequence(source, at + opener.length, true);
      const quantifier = readQuantifier(source, close + 1);
      out += `${opener}${inner})${quantifier}`;
      at = close + 1 + quantifier.length;
    } else {
      const [atom, next] = readAtom(source, at);
      const quantifier = readQuantifier(source, next);
      out += withQuantifier(atom, quantifier);
      at = next + quantifier.length;
    }
  }
  return nested ? unsupported(source, at) : [out, at];
}

/** `re` with a MARK allowed after each atom and in place of each space; throws on syntax it does not model. */
export function markTolerant(re: RegExp): RegExp {
  return new RegExp(rewriteSequence(re.source, 0, false)[0], re.flags);
}

const TOLERANT_PATTERNS: readonly InstructionPattern[] = INSTRUCTION_PATTERNS.map(
  ({ name, re, needs }) => ({
    name,
    re: markTolerant(re),
    ...(needs && { needs: markTolerant(needs) }),
  }),
);

/** The patterns in plain form, or in the form that reads a MARK, which only a screening form may meet. */
export function instructionPatterns(tolerant: boolean): readonly InstructionPattern[] {
  return tolerant ? TOLERANT_PATTERNS : INSTRUCTION_PATTERNS;
}

// A raw text may hold a MARK of its own, so the caller says which set reads it.
function matchedPattern(text: string, tolerant: boolean): string | null {
  for (const { name, re, needs } of instructionPatterns(tolerant)) {
    if (needs && !needs.test(text)) continue;
    if (re.test(text)) return `pattern:${name}`;
  }
  return null;
}

// `formOf` is a thunk so a phrase in plain sight never pays for the screening form.
function detectWithForm(content: string, formOf: () => string): InstructionDetection {
  // The text as written goes first: a phrase in plain sight is named before any smuggling rule, and
  // the screened form only adds flags.
  const plain = matchedPattern(content, false);
  if (plain !== null) return { flagged: true, reason: plain };
  if (ZERO_WIDTH_RUN_RE.test(content)) {
    return { flagged: true, reason: 'pattern:zero-width-smuggling' };
  }
  const screened = formOf();
  // A raw MARK is a mark in any form, so only a form with no MARK that equals the text skips the tolerant set.
  const unchanged = screened === content && !screened.includes(MARK);
  const disguised = unchanged ? null : matchedPattern(screened, true);
  if (disguised !== null) return { flagged: true, reason: disguised };
  if (BIDI_CONTROL_RE.test(content)) return { flagged: true, reason: 'pattern:bidi-control' };
  return { flagged: false, reason: null };
}

export function detectInstruction(content: string): InstructionDetection {
  return detectWithForm(content, () => screeningForm(content));
}

// The end of a reference the join may complete: an ampersand, then a hash, an x, digits or letters.
const PARTIAL_REFERENCE_RE = /&[#xX0-9a-zA-Z]*$/;

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

interface JoinedForms {
  /** The parts joined by a space. */
  spaced: string;
  /** The parts joined by nothing. */
  bare: string;
  /** True when a reference or an astral mark may form across the join, which only `bare` shows. */
  formsAcross: boolean;
}

/** The lead-in joined to the content, blanks cut at the join: a join reads as a space and as nothing. */
function joinedForms(leadIn: string, content: string): JoinedForms {
  const lead = withoutBlankEnd(leadIn);
  const body = withoutBlankStart(content);
  const pair =
    isHighSurrogate(lead.charCodeAt(lead.length - 1)) && isLowSurrogate(body.charCodeAt(0));
  return {
    spaced: `${lead} ${body}`,
    bare: `${lead}${body}`,
    formsAcross: pair || PARTIAL_REFERENCE_RE.test(lead),
  };
}

// A screening form has three blanks, each one UTF-16 unit, so an index loop cuts them.
function isFormBlank(unit: string): boolean {
  return unit === ' ' || unit === '\n' || unit === MARK;
}

function withoutFormBlankEnd(form: string): string {
  let end = form.length;
  while (end > 0 && isFormBlank(form.charAt(end - 1))) end -= 1;
  return form.slice(0, end);
}

function withoutFormBlankStart(form: string): string {
  let start = 0;
  while (start < form.length && isFormBlank(form.charAt(start))) start += 1;
  return form.slice(start);
}

function once(compute: () => string): () => string {
  let value: string | undefined;
  return () => (value ??= compute());
}

/** The text as shown, then the raw join, then each part screened: a phrase split any way across the parts is caught. */
export function detectInstructionIn(text: LeadInText): InstructionDetection {
  const { leadIn, content } = text;
  if (!leadIn) return detectInstruction(content);
  // Screening works one line at a time, so the shown form is the two part forms around the line break.
  const leadForm = once(() => screeningForm(leadIn));
  const contentForm = once(() => screeningForm(content));
  const shown = detectWithForm(shownText(text), () => `${leadForm()}\n${contentForm()}`);
  if (shown.flagged) return shown;
  const { spaced, bare, formsAcross } = joinedForms(leadIn, content);
  // Raw text may hold a MARK of its own, so it meets the original patterns.
  const rawReason = matchedPattern(spaced, false) ?? matchedPattern(bare, false);
  if (rawReason !== null) return { flagged: true, reason: rawReason };
  // A reference or a pair cut by the join forms only in the bare join, screened as one text.
  const joined = formsAcross ? detectInstruction(bare) : null;
  if (joined?.flagged) return joined;
  // One MARK at the join stands for a space and for nothing at once.
  const head = withoutFormBlankEnd(leadForm());
  const tail = withoutFormBlankStart(contentForm());
  const reason = matchedPattern(`${head}${MARK}${tail}`, true);
  return reason === null ? shown : { flagged: true, reason };
}

/** The tag list as a context line prints it; the write screen checks the content joined to this text.
 * The line's `**` between them only widens the gap. */
export function printedTags(tags: readonly string[]): string {
  return tags.length > 0 ? ` [${tags.join(', ')}]` : '';
}

/** The first flag in the text, in each tag, or in the text joined to the tags as a context line prints them;
 * each lead-in join is read as detectInstructionIn reads it. */
export function instructionIn(text: LeadInText, tags: readonly string[]): InstructionDetection {
  const found = detectInstructionIn(text);
  if (found.flagged || tags.length === 0) return found;
  for (const tag of tags) {
    const inTag = detectInstruction(tag);
    if (inTag.flagged) return inTag;
  }
  return detectInstructionIn({
    leadIn: text.leadIn,
    content: `${text.content}${printedTags(tags)}`,
  });
}
