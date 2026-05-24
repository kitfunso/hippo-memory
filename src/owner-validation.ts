/**
 * --owner format validation (B2 v1.12.6).
 *
 * Documented MEMORY_ENVELOPE.md contract: owner = `user:<id>` | `agent:<id>`
 * with id ∈ `[A-Za-z0-9_-]+`. Pre-v1.12.6 any string was accepted, leaving
 * the documented contract unenforced.
 *
 * Default: WARN-ONLY (log + accept) to preserve back-compat with existing
 * scripted callers passing legacy owner strings. Set `HIPPO_STRICT_OWNER=1`
 * to reject + exit. Strict mode will become the default once A5 v2 lands
 * (see `TODOS.md` A3 follow-ups for the migration path).
 */

export const OWNER_RE = /^(user|agent):[A-Za-z0-9_-]+$/;
export const OWNER_CONTRACT_HINT =
  'Must match ^(user|agent):[A-Za-z0-9_-]+$ (e.g. user:alice, agent:capture-bot).';

export interface OwnerValidation {
  ok: boolean;
  /** The owner string as the caller should now use it. undefined when no owner was supplied. */
  value: string | undefined;
  /** Human-readable message (warn or error). Empty when ok = true. */
  message: string;
}

/**
 * Pure validator. Returns `{ ok, value, message }`. Does NOT print or
 * `process.exit`. The CLI wrapper below handles side effects so this is
 * unit-testable.
 *
 * Behaviour:
 *   - owner undefined → ok=true, value=undefined, no message.
 *   - owner matches OWNER_RE → ok=true, value=owner.
 *   - owner doesn't match + strict=false → ok=true, value=owner (accept),
 *     message contains the warning text.
 *   - owner doesn't match + strict=true → ok=false, value=owner (echoed),
 *     message contains the error text.
 */
export function validateOwner(
  owner: string | null | undefined,
  opts: { strict?: boolean } = {},
): OwnerValidation {
  if (owner === undefined || owner === null || owner === '') {
    return { ok: true, value: undefined, message: '' };
  }
  if (OWNER_RE.test(owner)) {
    return { ok: true, value: owner, message: '' };
  }
  if (opts.strict) {
    return {
      ok: false,
      value: owner,
      message: `Invalid --owner "${owner}". ${OWNER_CONTRACT_HINT}`,
    };
  }
  return {
    ok: true,
    value: owner,
    message:
      `[warn] --owner "${owner}" does not match the contract. ${OWNER_CONTRACT_HINT} ` +
      `Accepting for back-compat; set HIPPO_STRICT_OWNER=1 to reject.`,
  };
}

/**
 * Returns true when strict-owner enforcement is enabled via env var.
 * Centralised here so any future bump to default-strict is one edit.
 */
export function isStrictOwnerEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HIPPO_STRICT_OWNER === '1';
}
