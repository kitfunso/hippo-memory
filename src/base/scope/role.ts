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
export const NO_MAPPED_GROUP = 'groups claim holds no mapped group';

/** True for a role that may write; a role outside the ladder fails closed. */
export function canWrite(role: Role): boolean {
  return role === 'member' || role === 'admin';
}

/** A caller's role as the ladder reads it: viewer sits below member, so any value outside the
 * ladder, a missing one included, must read as viewer to fail closed. */
export function roleOrViewer(value: Role | undefined): Role {
  return value === 'admin' || value === 'member' ? value : 'viewer';
}

/**
 * The role a groups claim earns. A lone string is one group, an array keeps only its string
 * entries, and any other shape (absent, null, number, boolean, object) matches no group. The
 * highest match wins (admin, editor, viewer) and groups compare exactly, as Entra sends GUIDs.
 * A claim that matches no group gives `fallback`, or `refused` when `fallback` is null, so a
 * deployment can turn away callers in no mapped group without scanning the claim twice. A claim
 * over 1024 entries is `refused`, checked before any entry is read; no text holds the claim. A
 * resolver returns null on `refused`, logs the reason and never logs the claim.
 * Entra leaves the claim out above 200 groups, so a deployment that uses viewer passes fallback
 * 'viewer', and a null fallback refuses those users. Map a team-admin IdP group to editor, never
 * admin, until team admin ships: admin covers the whole tenant.
 */
export function roleFromGroups(
  claim: JsonValue | undefined,
  groups: RoleGroups,
  fallback: Role | null,
): RoleFromGroups {
  if (isJsonString(claim)) return outcome(matched([claim], groups), fallback);
  if (!Array.isArray(claim)) return outcome(null, fallback);
  if (claim.length > MAX_GROUPS_CLAIM) return { refused: GROUPS_CLAIM_TOO_LONG };
  return outcome(
    matched(
      claim.filter((g) => isJsonString(g)),
      groups,
    ),
    fallback,
  );
}

function matched(held: readonly string[], groups: RoleGroups): Role | null {
  const hit = (list: readonly string[] | undefined): boolean =>
    Array.isArray(list) && list.some((g) => held.includes(g));
  if (hit(groups.admin)) return 'admin';
  if (hit(groups.editor)) return 'member';
  if (hit(groups.viewer)) return 'viewer';
  return null;
}

function outcome(earned: Role | null, fallback: Role | null): RoleFromGroups {
  const role = earned ?? fallback;
  return role === null ? { refused: NO_MAPPED_GROUP } : { role };
}
