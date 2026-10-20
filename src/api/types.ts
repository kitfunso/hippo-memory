// Request context (caller identity and tenant) shared by every API module, plus the recall contract error.

import { BadRequestError, ForbiddenError } from '../base/errors/api-errors.js';
import type { HippoStore } from '../store/port.js';
import type { HippoConfig } from '../base/config/config.js';
import type { OptionalGroup, StoreWith } from '../store/port.js';
import type { ConfiguredFolder } from '../domain/search/embed-memories.js';
import type { CallerState } from './callers.js';
import type { LocalStore, StoreReach } from '../store/local/index.js';

/** Actor identity + role for a Context: the audit-log subject (pass `ctx.actor.subject` to audit helpers) and the role
 *  for admin gating.
 *  Role checks happen at the request boundary (e.g. /v1/sleep), except in authCreate and authRevoke (ForbiddenError).
 */
export interface Actor {
  /** 'cli' | 'localhost:cli' | 'api_key:<key_id>' | 'mcp' | 'connector:slack' | 'connector:github' */
  subject: string;
  role: 'admin' | 'member';
  /** Restricted scopes a member key may read (auth.ts grantScope). Unused for admin actors. */
  scopes?: readonly string[];
  /** An auth resolver vouched for this caller, so its admin role stops at its own tenant. */
  viaAuthResolver?: true;
  /** The host's operator (CLI, stdio MCP, keyless loopback set to admin, host-tenant admin key): may act beyond its
   * tenant. */
  hostAdmin?: true;
  owner?: string; // the person behind the key; task state keys on it
}

/** The operator's global store in reach, with the config.json that ranks its rows and governs its ledger. */
export interface GlobalInReach {
  readonly root: string;
  readonly store: HippoStore;
  readonly config: HippoConfig;
}

/** A store reach as a composition root sets it: each global store carries its own config, so the api reads no file. */
export interface ContextReach extends StoreReach {
  readonly global?: GlobalInReach;
  readonly globalTarget?: ConfiguredFolder;
}

export interface Context {
  hippoRoot: string;
  tenantId: string;
  actor: Actor;
  /** Built by a composition root; every api function reads and writes storage only through it. */
  readonly store: HippoStore;
  /** Set by a composition root. Absent, the api reads one project and no global store, as for an integrator's store. */
  reach?: ContextReach;
  /** The store's config, loaded by the composition root once per command or request. */
  readonly config: HippoConfig;
  /** The root's per-caller state: recall rings, each client's last shown ids, and how a write starts a sleep. Absent, a
   * recall keeps no session history and a write starts no sleep. */
  readonly callers?: CallerState;
}

/** A root's reach with the global store's config loaded beside it; `configAt` is the root's own loader. */
export function contextReach(reach: StoreReach, configAt: (root: string) => HippoConfig): ContextReach {
  const { global, globalTarget, ...rest } = reach;
  // Both name the operator's global store, so one load serves both.
  let last: { readonly root: string; readonly config: HippoConfig } | undefined;
  const at = (root: string): HippoConfig => {
    if (last?.root !== root) last = { root, config: configAt(root) };
    return last.config;
  };
  let withConfig: ContextReach = rest;
  if (global !== undefined) withConfig = { ...withConfig, global: { ...global, config: at(global.root) } };
  if (globalTarget !== undefined) {
    withConfig = { ...withConfig, globalTarget: { ...globalTarget, config: at(globalTarget.root) } };
  }
  return withConfig;
}

/** Whether the store serves many people: the root's reach says, else the store's config for an integrator's store. */
export function sharedStoreOf(ctx: Pick<Context, 'reach' | 'config'>): boolean {
  return ctx.reach ? ctx.reach.shared : ctx.config.sharedStore;
}

/** A context whose store sets the optional groups `G`: the surface proved them once, so the api checks nothing. */
export type ContextWith<G extends OptionalGroup> = Context & { readonly store: StoreWith<G> };

/** A context whose store carries a folder's local files, as sleep, embedding and the project tags need. */
export type LocalContext = Context & { readonly store: LocalStore };

/** Builds process-local Actor values (admin and host admin) for CLI and CLI-run connector Contexts; Bearer-authed
 * callers build Actor from the api_keys row instead. */
export function adminActor(subject: string): Actor {
  return { subject, role: 'admin', hostAdmin: true };
}

/** Throws unless the caller is the host's operator: `action` reaches past the caller's tenant. */
export function requireHostAdmin(ctx: Context, action: string): void {
  if (!ctx.actor.hostAdmin) throw new ForbiddenError(`${action} requires a host admin`);
}

/** The per-person key: an unowned key gets its own bucket by key id rather than sharing one. */
export function ownerOrSubject(actor: Actor): string {
  return actor.owner ?? actor.subject;
}

/** Thrown by `api.recall` on a contract violation; the stable `code` lets callers discriminate without parsing the
 * message. 'fresh_tail_requires_session_id' (needs HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1) or
 * 'invalid_scorer_window' (0 would hit an uncapped fallback). */
export class RecallContractError extends BadRequestError {
  public readonly code: 'fresh_tail_requires_session_id' | 'invalid_scorer_window';
  constructor(code: 'fresh_tail_requires_session_id' | 'invalid_scorer_window', message: string) {
    super(message);
    this.name = 'RecallContractError';
    this.code = code;
  }
}
