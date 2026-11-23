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
  /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]{0,31});|(amp|lt|gt|quot|nbsp|shy))/g;
const LEADING_ZEROS_RE = /^0+/;
const MAX_REFERENCE_DIGITS = 7;
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

// Tag block stays for unicode-tag-chars; U+2800 draws blank with no property, and controls draw nothing
// either; White_Space stays a separator. One class, a run at a time, so a mark-heavy text is scanned once.
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

// A mark beside a space reads as a space both ways, and a run of marks as one mark. Plain
// substitutions, since a callback per run costs seconds on a megabyte of alternating marks.
const MARK_RUN_RE = /\uFDD0{2,}/g;
const MARK_BY_SPACE_RE = /\uFDD0(?= )|(?<= )\uFDD0/g;
const SPACE_PAIR_RE = / {2,}/g;

function referencedCharacter(
  reference: string,
  decimal?: string,
  hex?: string,
  name?: string,
  legacy?: string,
): string {
  const named = name ?? legacy;
  if (named !== undefined) {
    return NAMED_REFERENCES.get(named) ?? BLANK_REFERENCES.get(named) ?? reference;
  }
  const digits = (decimal ?? hex ?? '').replace(LEADING_ZEROS_RE, '');
  // HTML draws U+FFFD for a number with no character, and the mark stands for both readings of it.
  if (digits.length > MAX_REFERENCE_DIGITS) return MARK;
  const code = digits === '' ? 0 : Number.parseInt(digits, decimal === undefined ? 16 : 10);
  const drawn = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  // A referenced line break stays a mark: read as a break it would shut a gap the raw text leaves open.
  return drawn && code !== 10 ? String.fromCodePoint(code) : MARK;
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

type Atom = { readonly source: string; readonly kind: 'consuming' | 'blank' | 'zero-width' };

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
  while (close < source.length && source.charAt(close) !== ']') {
    close += source.charAt(close) === '\\' ? 2 : 1;
  }
  if (close >= source.length) return unsupported(source, at);
  // Only the placeholder after an atom may take a mark, or one mark could be taken two ways.
  const open = source.slice(at, close);
  return [{ source: `${open}${negated ? MARK_SOURCE : ''}]`, kind: 'consuming' }, close + 1];
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

function withQuantifier(atom: Atom, quantifier: string): string {
  if (atom.kind === 'zero-width') {
    return quantifier === '' ? atom.source : unsupported(atom.source, 0);
  }
  if (atom.kind === 'blank') return `${atom.source}${quantifier}`;
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

/** The patterns in plain form, or in the form that reads a MARK, for a text that holds one. */
export function instructionPatterns(marked: boolean): readonly InstructionPattern[] {
  return marked ? TOLERANT_PATTERNS : INSTRUCTION_PATTERNS;
}

function matchedPattern(text: string): string | null {
  for (const { name, re, needs } of instructionPatterns(text.includes(MARK))) {
    if (needs && !needs.test(text)) continue;
    if (re.test(text)) return `pattern:${name}`;
  }
  return null;
}

// `formOf` is a thunk so a phrase in plain sight never pays for the screening form.
function detectWithForm(content: string, formOf: () => string): InstructionDetection {
  // The text as written goes first: a phrase in plain sight is named before any smuggling rule, and
  // the screened form only adds flags.
  const plain = matchedPattern(content);
  if (plain !== null) return { flagged: true, reason: plain };
  if (ZERO_WIDTH_RUN_RE.test(content)) {
    return { flagged: true, reason: 'pattern:zero-width-smuggling' };
  }
  const screened = formOf();
  const disguised = screened === content ? null : matchedPattern(screened);
  if (disguised !== null) return { flagged: true, reason: disguised };
  if (BIDI_CONTROL_RE.test(content)) return { flagged: true, reason: 'pattern:bidi-control' };
  return { flagged: false, reason: null };
}

export function detectInstruction(content: string): InstructionDetection {
  return detectWithForm(content, () => screeningForm(content));
}

// One class, tested a code point at a time: a `+` run backtracks and a UTF-16 unit misses an astral mark.
const BLANK_CHAR_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\u2800]/u;
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
  /** The parts around one MARK, which reads as a space and as nothing. */
  marked: string;
  /** The parts joined by nothing, when a reference or an astral mark may form across the join. */
  bare: string | null;
}

/** The lead-in joined to the content, blanks cut at the join. */
function joinedForms(leadIn: string, content: string): JoinedForms {
  const lead = withoutBlankEnd(leadIn);
  const body = withoutBlankStart(content);
  const pair =
    isHighSurrogate(lead.charCodeAt(lead.length - 1)) && isLowSurrogate(body.charCodeAt(0));
  const formsAcross = pair || PARTIAL_REFERENCE_RE.test(lead);
  return { marked: `${lead}${MARK}${body}`, bare: formsAcross ? `${lead}${body}` : null };
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
  const { marked, bare } = joinedForms(leadIn, content);
  const rawReason = matchedPattern(marked);
  if (rawReason !== null) return { flagged: true, reason: rawReason };
  // A reference or a pair cut by the join forms only in the bare join, screened as one text.
  const joined = bare === null ? null : detectInstruction(bare);
  if (joined?.flagged) return joined;
  // One MARK at the join stands for a space and for nothing at once.
  const head = withoutFormBlankEnd(leadForm());
  const tail = withoutFormBlankStart(contentForm());
  const reason = matchedPattern(`${head}${MARK}${tail}`);
  return reason === null ? shown : { flagged: true, reason };
}
