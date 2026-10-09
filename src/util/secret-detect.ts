/**
 * Secret detection for memory content (memory scope isolation).
 *
 * Conservative, provider-bounded patterns only - a bare `sk-` in prose must
 * NOT flag. Detection gates two surfaces:
 *  - producer: shareMemory/autoShare never promote flagged rows to the
 *    global store;
 *  - consumer: ambient context (getContext) never injects a flagged row
 *    outside its owning project, and never anywhere when the row has no
 *    project origin. Explicit recall is unaffected - recalling a secret is
 *    a deliberate act.
 *
 * This is deliberately a thin slice of lifecycle compliance
 * (no PII detection). Write-time scrubbing covers only text no person
 * typed into hippo; see `vetSecrets`.
 *
 * Leaf module: keep free of imports from store/api/shared so all of them
 * can import it without cycles.
 */

/** Result of scanning one memory. `reason` names the tag or pattern that fired. */
export interface SecretDetection {
  flagged: boolean;
  reason: string | null;
}

/** Tags that flag a memory as secret, lower case; detectSecret folds a tag's case before the lookup. */
export const SECRET_TAGS: ReadonlySet<string> = new Set([
  'secret', 'api-key', 'apikey', 'credential', 'credentials',
  'token', 'password', 'private-key',
]);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  // A token may end in a hyphen, where `\b` holds only before a word character: a class that holds `-` runs to its end, and a fixed length may also close on a hyphen.
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}(?:\b|(?<=-))/ },
  // hk_ is hippo's own API key (src/store/auth.ts); npm, Hugging Face, GitLab and Slack webhook shapes follow gitleaks' rules.
  { name: 'hippo-api-key', re: /\bhk_[a-z2-7]{24}\.[a-z2-7]{32}\b/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'huggingface-token', re: /\bhf_[A-Za-z]{34}\b/ },
  { name: 'gitlab-token', re: /\bglpat-[\w-]{20,}/ },
  { name: 'google-oauth-token', re: /\bya29\.[\w-]{20,}/ },
  { name: 'slack-webhook', re: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // sk-... (OpenAI/Anthropic style) and sk_<vendor>_... shapes. Both require
  // a key-ish noun somewhere in the content (co-occurrence guard) so prose
  // like "the sk- prefix identifies API keys" without an actual long token
  // does not flag, but a stored key ("prod API key sk_live_...")
  // does.
  { name: 'sk-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'sk-underscore-key', re: /\bsk_[A-Za-z0-9]+_[A-Za-z0-9_]{6,}\b/ },
  // The value needs 12+ token-safe chars and a digit, or `token = estimateTokens(...)` and doc templates like user:password@ would hide code lessons from ambient context.
  // Secret names end in the keyword (dbPassword, PGPASSWORD) and token_url does not, so the match opens there and scans no prefix; pwd and pass need a _ as OLDPWD and bypass are not secrets.
  { name: 'secret-assignment', re: /(?:(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|(?<=_)(?:pwd|pass))(?:[_-]?(?:key(?:[_-]?base)?|value|secret))?['"]?\s*(?::=?|=>?)\s*['"]?|(?<=--)password(?:=|\s+))(?=[A-Za-z0-9_\-+/]*\d)[A-Za-z0-9_\-+/=]{12,}/i },
  { name: 'url-password', re: /(?<=[A-Za-z0-9]:\/\/)[^\s/:@?#]*:(?=[^\s/@?#]*\d)[^\s/@?#]+(?=@)/ },
];

const KEYISH_CONTEXT_RE = /key|token|secret|credential|bearer|auth|password/i;
const CO_OCCURRENCE_GUARDED = new Set(['sk-style-key', 'sk-underscore-key']);

// redactSecretsStrict-only: too noisy for whole-entry memory scanning, worth hiding once text leaves the machine.
const STRICT_ONLY_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bauthorization["']?\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /(?<=[A-Za-z0-9]:\/\/)[^\s/:@?#]*:[^\s/@?#]+(?=@)/g,
];

/**
 * Scan a memory's tags + content for secret material.
 * Pure and deterministic; no filesystem or store access.
 */
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

/**
 * Replace secret-shaped substrings in free text with a redaction marker.
 * Reuses the same `SECRET_PATTERNS` / co-occurrence guard as `detectSecret`
 * (which only flags whole-entry content) so callers that must persist raw
 * text that never passes through the normal capture content gate (e.g. the
 * pre-compact snapshot fields) can scrub it in place instead.
 */
export function redactSecrets(text: string): string {
  return redactText(text, false);
}

/** Only a run's first character starts a match, so a long run is scanned once; a domain's first label opens on a letter, so logo@2x.png and react@18.2.0 stay. */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** Memories never hold a raw email address (AGENTS.md); phone numbers are left alone, as their patterns misfire on ids. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** Stricter redaction for text that leaves the machine: no co-occurrence guard, plus Bearer and Basic auth headers and JWTs. */
export function redactSecretsStrict(text: string): string {
  return redactText(text, true);
}

/** The text a write keeps, plus what to tell its caller about secret material in it. */
export interface SecretVet {
  content: string;
  warnings: string[];
}

/** Write-time veto: `scrub` text no person typed gets capture's strict redaction; typed text is a person's own call, so it is kept and flagged. */
export function vetSecrets(content: string, tags: readonly string[], scrub: boolean): SecretVet {
  const kept = scrub ? redactSecretsStrict(content) : content;
  const warnings: string[] = [];
  if (kept !== content) {
    const found = detectSecret({ content, tags: [] }).reason;
    warnings.push(`secret-shaped text was redacted before storing${found ? ` (${found})` : ''}`);
  }
  const left = detectSecret({ content: kept, tags: [...tags] });
  if (left.flagged) {
    warnings.push(`content looks like a secret (${left.reason}) and was stored as sent; forget it if it should not be kept`);
  }
  return { content: kept, warnings };
}

const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/** Appended to a dead-letter row's error when `redactPayload` changed its body. */
export const DLQ_REDACTED_NOTE = 'secret-shaped text redacted, signature dropped; replay needs --force';

/** `vetSecrets` redaction for a raw webhook body: JSON stays valid for replay, and an untouched body stays byte-identical so its signature still verifies. */
export function redactPayload(raw: string): string {
  try {
    JSON.parse(raw);
  } catch {
    // Not JSON, so there is no structure to keep valid; redact the raw text.
    return redactSecretsStrict(raw);
  }
  return raw.replace(JSON_STRING, (literal) => {
    const text: string = JSON.parse(literal);
    const kept = redactSecretsStrict(text);
    return kept === text ? literal : JSON.stringify(kept);
  });
}

function redactText(text: string, strict: boolean): string {
  if (!text) return text;
  let result = text;
  // PEM/OpenSSH blocks first: SECRET_PATTERNS only matches BEGIN; consume through END, or to the end of a truncated block.
  result = result.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g,
    '[REDACTED]',
  );
  for (const { name, re } of SECRET_PATTERNS) {
    if (!strict && CO_OCCURRENCE_GUARDED.has(name) && !KEYISH_CONTEXT_RE.test(text)) continue;
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    result = result.replace(new RegExp(re.source, flags), '[REDACTED]');
  }
  if (strict) {
    for (const re of STRICT_ONLY_PATTERNS) result = result.replace(re, '[REDACTED]');
  }
  return result;
}
