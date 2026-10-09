/** Prompt-injection detection for untrusted memory content. Same shape as secret-detect.ts; leaf module, no store/api/shared imports. */

export interface InstructionDetection {
  flagged: boolean;
  reason: string | null;
}

const INSTRUCTION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'override-instructions', re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above)\b[^.\n]{0,40}\binstructions?\b/i },
  { name: 'role-reassignment', re: /\b(?:you are now|act as|pretend to be)\b[^.\n]{0,40}\b(?:an?\s+)?(?:ai|assistant|agent|system)\b/i },
  { name: 'chat-role-markup', re: /<\|im_start\|>|<\|system\|>|\[INST\]|<\/?system>|###\s*system\s*:/i },
  { name: 'system-prompt-reference', re: /\b(?:(?:override|ignore|bypass|replace|reveal)\b[^.\n]{0,40}\b(?:system prompt|developer message)|(?:system prompt|developer message)\b[^.\n]{0,40}\b(?:override|ignore|bypass|replace|reveal))\b/i },
  // "always"/"never" alone (ordinary PR prose) doesn't flag without an agent-facing target nearby too.
  {
    name: 'standing-order',
    re: /\b(?:from now on|whenever you|always|never)\b[^.\n]{0,50}\b(?:you must|(?:the ai|the assistant|the agent|claude|copilot)\s+(?:must|should|will)\b)/i
  },
  { name: 'concealment', re: /\b(?:do not|never|don't)\b[^.\n]{0,40}\b(?:tell|mention|reveal)\b[^.\n]{0,40}\bthe user\b/i },
  {
    name: 'remote-script-exec',
    re: /\b(?:curl|wget)\b[^\n|]{0,80}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\biex\s*\(\s*(?:iwr|invoke-webrequest|new-object\s+net\.webclient)/i
  },
  {
    name: 'exfiltration',
    re: /\b(?:send|post|upload|exfiltrate)\b[^.\n]{0,40}\b(?:secrets?|tokens?|api[- ]?keys?|credentials?|env(?:ironment)? variables?)\b/i
  },
  { name: 'unicode-tag-chars', re: /[\u{E0000}-\u{E007F}]/u },
];

// A stray zero-width char has legitimate uses (ZWJ); only a run of 3+ adjacent ones reads as smuggling.
const ZERO_WIDTH_RUN_RE = /[\u200B-\u200F\u2060-\u2064]{3,}/;

// Reorders what is drawn without changing a byte a pattern reads, and ordinary right-to-left prose never needs one.
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/;

// A renderer draws a reference as the character it names: decimal, hex, or one of the five names XML defines.
const CHARACTER_REFERENCE_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

// Drawn with no width, so one inside a word splits it for a pattern and not for a reader: soft hyphen, joiners, zero-width and bidi format characters.
const INVISIBLE_RE = /[\u034F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Cyrillic, then Greek, letters drawn like a c e i j o p s x y; closed at those, so Russian or Greek prose folds into no phrase a pattern names.
const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  ['\u0430', 'a'], ['\u0441', 'c'], ['\u0435', 'e'], ['\u0456', 'i'], ['\u0458', 'j'], ['\u043E', 'o'], ['\u0440', 'p'], ['\u0455', 's'],
  ['\u0445', 'x'], ['\u0443', 'y'],
  ['\u0410', 'A'], ['\u0421', 'C'], ['\u0415', 'E'], ['\u0406', 'I'], ['\u0408', 'J'], ['\u041E', 'O'], ['\u0420', 'P'], ['\u0405', 'S'],
  ['\u0425', 'X'], ['\u0423', 'Y'],
  ['\u03B1', 'a'], ['\u03B5', 'e'], ['\u03B9', 'i'], ['\u03F3', 'j'], ['\u03BF', 'o'], ['\u03C1', 'p'], ['\u03C7', 'x'], ['\u03B3', 'y'],
  ['\u0391', 'A'], ['\u0395', 'E'], ['\u0399', 'I'], ['\u037F', 'J'], ['\u039F', 'O'], ['\u03A1', 'P'], ['\u03A7', 'X'], ['\u03A5', 'Y'],
]);
const GREEK_OR_CYRILLIC_RE = /[\u0370-\u03FF\u0400-\u04FF]/g;

// A line break stays: it is the sentence bound the patterns rely on where a list or a chat message ends a line with no full stop.
const SPACE_RUN_RE = /[^\S\n]+/g;

function referencedCharacter(reference: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_REFERENCES.get(name) ?? reference;
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
  // NUL, half a surrogate pair and a number past Unicode name no character, so the reference is read as written.
  const drawn = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return drawn ? String.fromCodePoint(code) : reference;
}

/** `content` as a reader or a model takes it in. For matching only: what is stored is never this. */
function screeningForm(content: string): string {
  return content
    .replace(CHARACTER_REFERENCE_RE, referencedCharacter)
    // Full-width, mathematical and enclosed letters become the plain ones, and every space character a U+0020.
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(GREEK_OR_CYRILLIC_RE, (letter) => LOOKALIKES.get(letter) ?? letter)
    .replace(SPACE_RUN_RE, ' ');
}

function matchedPattern(text: string): string | null {
  for (const { name, re } of INSTRUCTION_PATTERNS) {
    if (re.test(text)) return `pattern:${name}`;
  }
  return null;
}

export function detectInstruction(content: string): InstructionDetection {
  // The text as written goes first: a phrase in plain sight is named before any smuggling rule, and the screening form only adds flags.
  const plain = matchedPattern(content);
  if (plain !== null) return { flagged: true, reason: plain };
  if (ZERO_WIDTH_RUN_RE.test(content)) {
    return { flagged: true, reason: 'pattern:zero-width-smuggling' };
  }
  const screened = screeningForm(content);
  const disguised = screened === content ? null : matchedPattern(screened);
  if (disguised !== null) return { flagged: true, reason: disguised };
  if (BIDI_CONTROL_RE.test(content)) return { flagged: true, reason: 'pattern:bidi-control' };
  return { flagged: false, reason: null };
}
