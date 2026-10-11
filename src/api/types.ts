// Request context (caller identity and tenant) shared by every API module, plus the recall contract error.

import { BadRequestError, ForbiddenError } from '../core/api-errors.js';
import type { HippoStore } from '../store/index.js';

/** Actor identity + role for a Context: the audit-log subject (pass `ctx.actor.subject` to audit helpers) and the role for admin gating.
 * Role checks happen at the request boundary (e.g. /v1/sleep), except in authCreate and authRevoke (ForbiddenError). */
export interface Actor {
  /** 'cli' | 'localhost:cli' | 'api_key:<key_id>' | 'mcp' | 'connector:slack' | 'connector:github' */
  subject: string;
  role: 'admin' | 'member';
  /** Restricted scopes a member key may read (auth.ts grantScope). Unused for admin actors. */
  scopes?: readonly string[];
  /** An auth resolver vouched for this caller, so its admin role stops at its own tenant. */
  viaAuthResolver?: true;
  /** The host's operator (CLI, stdio MCP, keyless loopback, host-tenant admin key): may act beyond its tenant. */
  hostAdmin?: true;
  owner?: string; // the person behind the key; task state keys on it
}

export interface Context {
  hippoRoot: string;
  tenantId: string;
  actor: Actor;
  store?: HippoStore;
}

export type HippoDbContext = Context & { store?: undefined };

// hippoRoot keeps the second test off TypeScript's weak-type rule, which would fail a ctx with no store key at all.
export type StoreReply<C extends Context, R> = C extends { readonly store: HippoStore }
  ? Promise<R>
  : C extends { readonly hippoRoot: string; readonly store?: undefined } ? R : R | Promise<R>;

/** Builds process-local Actor values (admin and host admin) for CLI and CLI-run connector Contexts; Bearer-authed callers build Actor from the api_keys row
 * instead. */
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

/** Thrown by `api.recall` on a contract violation; the stable `code` lets callers discriminate without parsing the message.
 * 'fresh_tail_requires_session_id' (needs HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1) or 'invalid_scorer_window' (0 would hit an uncapped fallback). */
export class RecallContractError extends BadRequestError {
  public readonly code:
    | 'fresh_tail_requires_session_id'
    | 'invalid_scorer_window';
  constructor(
    code:
      | 'fresh_tail_requires_session_id'
      | 'invalid_scorer_window',
    message: string,
  ) {
    super(message);
    this.name = 'RecallContractError';
    this.code = code;
  }
}
