// Secret detection and the stored form of every text: provider-bounded patterns, so a bare `sk-` in prose stays.
// A flagged row is never shared to the global store or injected outside its project. Leaf module.
import { createHash } from 'node:crypto';
import { tryParseJson } from './json.js';
import { ID_SUFFIX_CHARS } from './token-text.js';

/** Result of scanning one memory. `reason` names the tag or pattern that fired. */
export interface SecretDetection {
  flagged: boolean;
  reason: string | null;
}

/** Tags that flag a memory as secret, lower case; detectSecret folds a tag's case before the
 * lookup. */
export const SECRET_TAGS: ReadonlySet<string> = new Set([
  'secret',
  'api-key',
  'apikey',
  'credential',
  'credentials',
  'token',
  'password',
  'private-key',
]);

// A provider token opens and closes where no letter or digit touches it, so `_`, `-`, `.` and `/` all
// bound one (`note_ghp_...` too); `\b` would count `_` as part of the word.
const OPEN = '(?<![A-Za-z0-9])';
const CLOSE = '(?![A-Za-z0-9])';
const bounded = (source: string, close = CLOSE): RegExp => new RegExp(`${OPEN}${source}${close}`);
/** A pattern; `keyShaped` ones have an open body that words joined by `-` or `_` also fill, so a match counts
 * only when its `body` group holds a digit or a capital letter (keyShapedBody). */
interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
  readonly keyShaped?: true;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'aws-access-key', re: bounded(String.raw`AKIA[0-9A-Z]{16}`) },
  { name: 'github-token', re: bounded(String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}`) },
  { name: 'github-fine-grained-pat', re: bounded(String.raw`github_pat_[A-Za-z0-9_]{22,}`) },
  // A class that holds `-` runs to its end, so a token that ends in a hyphen needs no close.
  {
    name: 'slack-token',
    re: bounded(String.raw`xox[baprs]-(?<body>[A-Za-z0-9-]{10,})`, ''),
    keyShaped: true,
  },
  { name: 'stripe-key', re: bounded(String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`) },
  { name: 'google-api-key', re: bounded(String.raw`AIza[0-9A-Za-z_-]{35}`, `(?:${CLOSE}|(?<=-))`) },
  // hk_ is hippo's own API key (sqlite/auth.ts); npm, Hugging Face, GitLab and Slack webhook shapes
  // follow gitleaks' rules.
  { name: 'hippo-api-key', re: bounded(String.raw`hk_[a-z2-7]{24}\.[a-z2-7]{32}`) },
  { name: 'npm-token', re: bounded(String.raw`npm_[A-Za-z0-9]{36}`) },
  { name: 'huggingface-token', re: bounded(String.raw`hf_[A-Za-z]{34}`) },
  { name: 'gitlab-token', re: bounded(String.raw`glpat-(?<body>[\w-]{20,})`, ''), keyShaped: true },
  {
    name: 'google-oauth-token',
    re: bounded(String.raw`ya29\.(?<body>[\w-]{20,})`, ''),
    keyShaped: true,
  },
  {
    name: 'slack-webhook',
    re: bounded(
      String.raw`hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}`,
      '',
    ),
  },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // detectSecret flags sk- and sk_<vendor>_ only beside a key-ish noun.
  {
    name: 'sk-style-key',
    re: bounded(String.raw`sk-(?<body>[A-Za-z0-9_-]{20,})`, ''),
    keyShaped: true,
  },
  {
    name: 'sk-underscore-key',
    re: bounded(String.raw`sk_(?<body>[A-Za-z0-9]+_[A-Za-z0-9_]{6,})`),
    keyShaped: true,
  },
  // A value needs 12+ token-safe chars and a digit, so `token = estimateTokens(...)` stays; the match opens at
  // the keyword a secret name ends in (dbPassword), and pwd and pass need a `_` (OLDPWD, bypass).
  {
    name: 'secret-assignment',
    re: new RegExp(
      String.raw`(?:(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|(?<=_)(?:pwd|pass))` +
        String.raw`(?:[_-]?(?:key(?:[_-]?base)?|value|secret))?['"]?\s*(?::=?|=>?)\s*['"]?|(?<=--)password(?:=|\s+))` +
        String.raw`(?=[A-Za-z0-9_\-+/]*\d)[A-Za-z0-9_\-+/=]{12,}`,
      'i',
    ),
  },
  { name: 'url-password', re: /(?<=[A-Za-z0-9]:\/\/)[^\s/:@?#]*:(?=[^\s/@?#]*\d)[^\s/@?#]+(?=@)/ },
];

const KEYISH_CONTEXT_RE = /key|token|secret|credential|bearer|auth|password/i;
const CO_OCCURRENCE_GUARDED = new Set(['sk-style-key', 'sk-underscore-key']);

// Redacted in every stored text but never flagged by detectSecret, whose flag withholds a whole row;
// prose can trip them ("bearer responsibilities ..."), and the stored form then hides the words.
const STRICT_ONLY_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bauthorization["']?\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /(?<=[A-Za-z0-9]:\/\/)[^\s/:@?#]*:[^\s/@?#]+(?=@)/g,
];

/** A random key body holds a digit or a capital; a name in lowercase words almost never does. Checked on the
 * matched body after the match, never as a lookahead, so a long run is scanned once. */
const keyShapedBody = (m: RegExpExecArray): boolean => /[0-9A-Z]/.test(m.groups?.body ?? '');

// Global copies built once; matchAll clones a RegExp, so calls share no lastIndex.
const SECRET_GLOBAL: readonly SecretPattern[] = SECRET_PATTERNS.map((p) => ({
  ...p,
  re: new RegExp(p.re.source, `${p.re.flags}g`),
}));
const STRICT_GLOBAL: readonly SecretPattern[] = [
  ...SECRET_GLOBAL,
  ...STRICT_ONLY_PATTERNS.map((re, i) => ({ name: `strict-${i}`, re })),
];

/** Each match of `pattern` in `text` that counts: every match, or for a keyShaped pattern a key-shaped body. */
function* hits({ re, keyShaped }: SecretPattern, text: string): Generator<RegExpExecArray> {
  for (const m of text.matchAll(re)) {
    if (m[0].length > 0 && (!keyShaped || keyShapedBody(m))) yield m;
  }
}

/** Scan a memory's tags + content for secret material; pure and deterministic, no filesystem or
 * store access. */
export function detectSecret(entry: { content: string; tags: string[] }): SecretDetection {
  for (const tag of entry.tags) {
    if (SECRET_TAGS.has(tag.toLowerCase())) {
      return { flagged: true, reason: `tag:${tag.toLowerCase()}` };
    }
  }
  for (const pattern of SECRET_GLOBAL) {
    const { name } = pattern;
    if (hits(pattern, entry.content).next().done) continue;
    if (CO_OCCURRENCE_GUARDED.has(name) && !KEYISH_CONTEXT_RE.test(entry.content)) continue;
    return { flagged: true, reason: `pattern:${name}` };
  }
  return { flagged: false, reason: null };
}

/** Only a run's first character starts a match, so a long run is scanned once; a domain's first
 * label opens on a letter, so logo@2x.png and react@18.2.0 stay. */
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/**
 * Memories never hold a raw email address (AGENTS.md); phone numbers are left alone, as their
 * patterns misfire on ids.
 */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** The text a write keeps, plus what to tell its caller about secret material in it. */
export interface SecretVet {
  content: string;
  warnings: string[];
}

/** Write-time veto: every caller's text gets the strict redaction, typed or not, so no secret
 * reaches the store. */
export function vetSecrets(content: string): SecretVet {
  const kept = redactSecretsStrict(content);
  const warnings: string[] = [];
  if (kept !== content) {
    const found = detectSecret({ content, tags: [] }).reason;
    warnings.push(`secret-shaped text was redacted before storing${found ? ` (${found})` : ''}`);
  }
  return { content: kept, warnings };
}

const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/** Appended to a dead-letter row's error when `redactPayload` changed its body. */
export const DLQ_REDACTED_NOTE =
  'secret-shaped text redacted, signature dropped; replay needs --force';

/**
 * `vetSecrets` redaction for a raw webhook body: JSON stays valid for replay, and an untouched body
 * stays byte-identical so its signature still verifies.
 */
export function redactPayload(raw: string): string {
  // Not JSON, so there is no structure to keep valid; redact the raw text.
  if (tryParseJson(raw) === undefined) return redactSecretsStrict(raw);
  return raw.replace(JSON_STRING, (literal) => {
    const text: string = JSON.parse(literal);
    const kept = redactSecretsStrict(text);
    return kept === text ? literal : JSON.stringify(kept);
  });
}

const PEM_BEGIN = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`;
const PEM_END = String.raw`-----END [A-Z ]*PRIVATE KEY-----`;

/** A [start, end) range of a text that a strict pattern or a PEM block covers. */
type Span = readonly [number, number];

/** Each PEM/OpenSSH block through its END line, or to the end of a truncated block; one forward
 * scan, so no ReDoS. Per-call RegExps, so no call shares lastIndex state. */
function pemSpans(text: string): Span[] {
  if (!text.includes('-----BEGIN ')) return [];
  const begins = new RegExp(PEM_BEGIN, 'g');
  const ends = new RegExp(PEM_END, 'g');
  const spans: Span[] = [];
  for (let begin = begins.exec(text); begin; begin = begins.exec(text)) {
    ends.lastIndex = begins.lastIndex;
    const end = ends.exec(text);
    const to = end ? ends.lastIndex : text.length;
    spans.push([begin.index, to]);
    begins.lastIndex = to;
  }
  return spans;
}

/** Every secret span of `text`, matched on the whole text, sorted, overlapping spans merged. */
export function secretSpans(text: string): Span[] {
  if (!text) return [];
  const found: Span[] = pemSpans(text);
  for (const pattern of STRICT_GLOBAL) {
    for (const m of hits(pattern, text)) found.push([m.index, m.index + m[0].length]);
  }
  if (found.length < 2) return found;
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const REDACTED = '[REDACTED]';

/** `text` with the i-th span replaced by `marker(i)`. */
function replaceSpans(text: string, spans: readonly Span[], marker: (i: number) => string): string {
  let out = '';
  let from = 0;
  spans.forEach(([start, end], i) => {
    out += `${text.slice(from, start)}${marker(i)}`;
    from = end;
  });
  return out + text.slice(from);
}

/** The stored form of every text hippo.db keeps, and of text that leaves the machine: each secret span
 * becomes the marker, with no co-occurrence guard, so Bearer and Basic headers, JWTs and URL passwords count. */
export function redactSecretsStrict(text: string): string {
  const spans = secretSpans(text);
  return spans.length === 0 ? text : replaceSpans(text, spans, () => REDACTED);
}

/** The stored form of an optional text column; null when there is no text. */
export function storedOrNull(text: string | null | undefined): string | null {
  return text == null ? null : redactSecretsStrict(text);
}

// SHORTCUT: an unkeyed digest lets a row holder confirm a guessed low-entropy secret; a per-store key fixes it.
const digest = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, ID_SUFFIX_CHARS);
/** A marker naming its raw part; the multi-pass loop in storedSource makes the stored form stable. */
const taggedMarker = (raw: string): string => `[REDACTED~${digest(raw)}]`;
const isSeparator = (ch: string): boolean => ch === '/' || ch === '#';
/** Passes before a source whose stored form keeps making new spans collapses to one tagged marker. */
const MAX_SOURCE_PASSES = 4;

/** One pass: split at `/` and `#` outside every span, so each span sits in one part; a part holding a span
 * gets its spans as markers, the last naming the raw part. */
function storeSpannedParts(text: string, spans: readonly Span[]): string {
  let out = '';
  let start = 0;
  let k = 0;
  for (let i = 0; i <= text.length; i++) {
    while (k < spans.length && spans[k][1] <= i) k++;
    const inSpan = k < spans.length && spans[k][0] <= i;
    if (i < text.length && (inSpan || !isSeparator(text[i]))) continue;
    const part = text.slice(start, i);
    const own = spans
      .filter(([from, to]) => from >= start && to <= i)
      .map(([from, to]): Span => [from - start, to - start]);
    const last = own.length - 1;
    out +=
      last < 0
        ? part
        : replaceSpans(part, own, (j) => (j === last ? taggedMarker(part) : REDACTED));
    if (i < text.length) out += text[i];
    start = i + 1;
  }
  return out;
}

/** The one stored form of `source`: spans found on the whole source, split only outside them, so a part
 * is distinct stored exactly when it is raw. A source with no span comes back unchanged. */
export function storedSource(source: string): string {
  let out = source;
  for (let pass = 0; pass < MAX_SOURCE_PASSES; pass++) {
    const spans = secretSpans(out);
    if (spans.length === 0) return out;
    out = storeSpannedParts(out, spans);
  }
  return secretSpans(out).length === 0 ? out : taggedMarker(source);
}

/** Every form a row's `source` may hold for `source`: the stored form, then a raw older one. */
export function sourceForms(source: string): readonly string[] {
  const stored = storedSource(source);
  return stored === source ? [source] : [stored, source];
}

/** The entry as stored, content redacted and source in its stored form; the same object when that
 * changes nothing. */
export function redactEntry<T extends { content: string; source?: string | null }>(entry: T): T {
  const content = redactSecretsStrict(entry.content);
  const source = entry.source && storedSource(entry.source);
  if (content === entry.content && source === entry.source) return entry;
  return source === entry.source ? { ...entry, content } : { ...entry, content, source };
}

/** True when a row's `held` source is `given` in stored form; a raw older source matches too. */
export function sameStoredSource(held: string | null | undefined, given: string): boolean {
  return held != null && storedSource(held) === storedSource(given);
}

/** True when `held` is `given` as stored; a raw legacy copy of the same text matches too. */
export function sameStoredText(held: string | null | undefined, given: string): boolean {
  return held != null && redactSecretsStrict(held) === redactSecretsStrict(given);
}

/** Every form a stored copy of `text` may hold: the stored form, then the raw text when a row
 * written before redaction keeps it. */
export function textForms(text: string): readonly string[] {
  const stored = redactSecretsStrict(text);
  return stored === text ? [text] : [stored, text];
}

/** True for a stored text whose redaction markers leave no letter or digit, so it names no value. */
export function onlyRedacted(stored: string): boolean {
  return stored.includes(REDACTED) && !/[\p{L}\p{N}]/u.test(stored.replaceAll(REDACTED, ''));
}
