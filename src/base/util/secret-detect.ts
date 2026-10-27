/**
 * Secret detection for memory content: conservative provider-bounded patterns (a bare `sk-` in
 * prose must not flag). Flagged rows are never shared to the global store or injected as ambient
 * context outside their project; explicit recall is unaffected. Leaf module: no imports from
 * store/api/shared.
 */
import { tryParseJson } from './json.js';

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

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  // A token may end in a hyphen, where `\b` holds only before a word character: a class that holds
  // `-` runs to its end, and a fixed length may also close on a hyphen.
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}(?:\b|(?<=-))/ },
  // hk_ is hippo's own API key (sqlite/auth.ts); npm, Hugging Face, GitLab and Slack webhook shapes
  // follow gitleaks' rules.
  { name: 'hippo-api-key', re: /\bhk_[a-z2-7]{24}\.[a-z2-7]{32}\b/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'huggingface-token', re: /\bhf_[A-Za-z]{34}\b/ },
  { name: 'gitlab-token', re: /\bglpat-[\w-]{20,}/ },
  { name: 'google-oauth-token', re: /\bya29\.[\w-]{20,}/ },
  {
    name: 'slack-webhook',
    re: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/,
  },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // sk-... (OpenAI/Anthropic) and sk_<vendor>_... shapes need a key-ish noun nearby (co-occurrence
  // guard), so prose like "the sk- prefix identifies API keys" does not flag but "prod API key
  // sk_live_..." does.
  { name: 'sk-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'sk-underscore-key', re: /\bsk_[A-Za-z0-9]+_[A-Za-z0-9_]{6,}\b/ },
  // Value needs 12+ token-safe chars and a digit, or `token = estimateTokens(...)` and
  // user:password@ templates would hide code lessons from ambient context. Secret names end in the
  // keyword (dbPassword), so the match opens there, no prefix scan; pwd and pass need a _ (OLDPWD,
  // bypass are not secrets).
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

/** Scan a memory's tags + content for secret material; pure and deterministic, no filesystem or
 * store access. */
export function detectSecret(entry: { content: string; tags: string[] }): SecretDetection {
  for (const tag of entry.tags) {
    if (SECRET_TAGS.has(tag.toLowerCase())) {
      return { flagged: true, reason: `tag:${tag.toLowerCase()}` };
    }
  }
  for (const { name, re } of SECRET_PATTERNS) {
    if (!re.test(entry.content)) continue;
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

/** Each PEM/OpenSSH block through its END line, or to the end of a truncated block; one forward
 * scan, so no ReDoS. Per-call RegExps, so no call shares lastIndex state. */
function redactPemBlocks(text: string): string {
  if (!text.includes('-----BEGIN ')) return text;
  const begins = new RegExp(PEM_BEGIN, 'g');
  const ends = new RegExp(PEM_END, 'g');
  let out = '';
  let from = 0;
  for (let begin = begins.exec(text); begin; begin = begins.exec(text)) {
    ends.lastIndex = begins.lastIndex;
    const end = ends.exec(text);
    out += `${text.slice(from, begin.index)}[REDACTED]`;
    from = end ? ends.lastIndex : text.length;
    begins.lastIndex = from;
  }
  return out + text.slice(from);
}

// Global copies built once: replace() resets lastIndex, so calls share them; detectSecret keeps its
// own non-global patterns, whose test() holds no state.
const STRICT_GLOBAL: readonly RegExp[] = SECRET_PATTERNS.map(
  ({ re }) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
);

const REDACTED = '[REDACTED]';

/**
 * Stricter redaction for text that leaves the machine: no co-occurrence guard, plus Bearer and
 * Basic auth headers and JWTs. It is also the stored form of every text hippo.db keeps.
 */
export function redactSecretsStrict(text: string): string {
  if (!text) return text;
  // PEM blocks first: SECRET_PATTERNS only matches the BEGIN line.
  let result = redactPemBlocks(text);
  for (const re of STRICT_GLOBAL) result = result.replace(re, REDACTED);
  for (const re of STRICT_ONLY_PATTERNS) result = result.replace(re, REDACTED);
  return result;
}

/** The stored form of an optional text column; null when there is no text. */
export function storedOrNull(text: string | null | undefined): string | null {
  return text == null ? null : redactSecretsStrict(text);
}

/** The entry as stored, content and source redacted; the same object when redaction changes
 * nothing. */
export function redactEntry<T extends { content: string; source?: string | null }>(entry: T): T {
  const content = redactSecretsStrict(entry.content);
  const source = entry.source && redactSecretsStrict(entry.source);
  if (content === entry.content && source === entry.source) return entry;
  return source === entry.source ? { ...entry, content } : { ...entry, content, source };
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
