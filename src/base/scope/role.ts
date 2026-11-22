// The role ladder, and the rule that maps an IdP groups claim onto it.
import { isJsonString, type JsonValue } from '../util/json.js';

/** A stored role: 'member' is the editor, and the stored name stays. */
export type Role = 'viewer' | 'member' | 'admin';

/** The least role a route lets in. */
export type RoleLevel = 'viewer' | 'editor' | 'admin';

export const ROLE_LEVELS: ReadonlySet<string> = new Set(['viewer', 'editor', 'admin']);

/** The IdP groups that grant each level; a caller in none of them gets the fallback. */
export interface RoleGroups {
  readonly viewer?: readonly string[];
  readonly editor?: readonly string[];
  readonly admin?: readonly string[];
}

export type RoleFromGroups = { readonly role: Role } | { readonly refused: string };

const MAX_GROUPS_CLAIM = 1024;

export const VIEWER_REFUSAL = 'forbidden: the viewer role can read but not write';
export const GROUPS_CLAIM_TOO_LONG = `groups claim lists more than ${MAX_GROUPS_CLAIM} groups`;

/** True for a role that may write; a role outside the ladder fails closed. */
export function canWrite(role: Role): boolean {
  return role === 'member' || role === 'admin';
}

/**
 * The role a groups claim earns. A lone string is one group, an array keeps only its string
 * entries, and any other shape (absent, null, number, boolean, object) gives `fallback`. The
 * highest match wins (admin, editor, viewer) and groups compare exactly, as Entra sends GUIDs.
 * A claim over 1024 entries is `refused`, checked before any entry is read; the text never holds
 * the claim. A resolver returns null on `refused`, logs the reason and never logs the claim.
 * Entra leaves the claim out above 200 groups, so a deployment that uses viewer passes fallback
 * 'viewer'.
 */
export function roleFromGroups(
  claim: JsonValue | undefined,
  groups: RoleGroups,
  fallback: Role,
): RoleFromGroups {
  if (isJsonString(claim)) return { role: matched([claim], groups, fallback) };
  if (!Array.isArray(claim)) return { role: fallback };
  if (claim.length > MAX_GROUPS_CLAIM) return { refused: GROUPS_CLAIM_TOO_LONG };
  return {
    role: matched(
      claim.filter((g) => isJsonString(g)),
      groups,
      fallback,
    ),
  };
}

function matched(held: readonly string[], groups: RoleGroups, fallback: Role): Role {
  // Plugin code may pass a non-array despite the type, which counts as an empty list.
  const hit = (list: readonly string[] | undefined): boolean =>
    Array.isArray(list) && list.some((g) => held.includes(g));
  if (hit(groups.admin)) return 'admin';
  if (hit(groups.editor)) return 'member';
  if (hit(groups.viewer)) return 'viewer';
  return fallback;
}
