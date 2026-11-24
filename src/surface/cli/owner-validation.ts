import { processEnv } from '../../base/util/env.js';

const OWNER_RE = /^(user|agent):[A-Za-z0-9_-]+$/;
export const OWNER_CONTRACT_HINT =
  'Must match ^(user|agent):[A-Za-z0-9_-]+$ (e.g. user:alice, agent:capture-bot).';

export interface OwnerValidation {
  ok: boolean;
  value: string | undefined;
  message: string;
}

/** Pure validator returning `{ ok, value, message }`; never prints or exits, so it is
 * unit-testable. A non-matching owner is accepted with a warning unless strict, where ok=false
 * with an error message. */
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
