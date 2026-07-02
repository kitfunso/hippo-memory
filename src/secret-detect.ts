/**
 * Secret detection for memory content (v39 memory scope isolation, S4;
 * docs/plans/2026-07-01-memory-scope-isolation.md).
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
 * This is deliberately a thin slice of the A4 lifecycle-compliance item
 * (no write-time scrubbing, no PII detection).
 *
 * Leaf module: keep free of imports from store/api/shared so all of them
 * can import it without cycles.
 */

/** Result of scanning one memory. `reason` names the tag or pattern that fired. */
export interface SecretDetection {
  flagged: boolean;
  reason: string | null;
}

const SECRET_TAGS = new Set([
  'secret', 'api-key', 'apikey', 'credential', 'credentials',
  'token', 'password', 'private-key',
]);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // sk-... (OpenAI/Anthropic style) and sk_<vendor>_... shapes. Both require
  // a key-ish noun somewhere in the content (co-occurrence guard) so prose
  // like "the sk- prefix identifies API keys" without an actual long token
  // does not flag, but a stored key ("2chain prod API key sk_keith_...")
  // does.
  { name: 'sk-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'sk-underscore-key', re: /\bsk_[A-Za-z0-9]+_[A-Za-z0-9_]{6,}\b/ },
  // Generic assignment: api_key=..., password: ..., token = "..." where the
  // value actually LOOKS like a credential: 12+ chars drawn only from
  // token-safe characters AND containing at least one digit. Without both
  // constraints this pattern flags ordinary code snippets and prose -
  // `token = estimateTokens(entry.content)` and "the secret: incremental-
  // rollout worked well" were verified false positives that would silently
  // hide real code-lesson memories from ambient context (post-merge
  // adversarial review, 2026-07-02).
  { name: 'secret-assignment', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?(?=[A-Za-z0-9_\-+/=]*\d)[A-Za-z0-9_\-+/=]{12,}/i },
];

const KEYISH_CONTEXT_RE = /key|token|secret|credential|bearer|auth|password/i;
const CO_OCCURRENCE_GUARDED = new Set(['sk-style-key', 'sk-underscore-key']);

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
