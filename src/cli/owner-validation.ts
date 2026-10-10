/** --owner validation per MEMORY_ENVELOPE.md: `user:<id>` | `agent:<id>`, id in `[A-Za-z0-9_-]+`.
 * Warn-only by default for legacy scripted callers; `HIPPO_STRICT_OWNER=1` rejects and exits. */

import { processEnv } from '../util/env.js';

const OWNER_RE = /^(user|agent):[A-Za-z0-9_-]+$/;
export const OWNER_CONTRACT_HINT =
  'Must match ^(user|agent):[A-Za-z0-9_-]+$ (e.g. user:alice, agent:capture-bot).';

export interface OwnerValidation {
  ok: boolean;
  /** The owner string as the caller should now use it. undefined when no owner was supplied. */
  value: string | undefined;
  /** Human-readable message (warn or error). Empty when ok = true. */
  message: string;
}

/** Pure validator returning `{ ok, value, message }`; never prints or exits, so it is unit-testable.
 * A non-matching owner is accepted with a warning unless strict, where ok=false with an error message. */
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

/** True when strict-owner enforcement is enabled via env var. */
export function isStrictOwnerEnv(env: NodeJS.ProcessEnv = processEnv()): boolean {
  return env.HIPPO_STRICT_OWNER === '1';
}
