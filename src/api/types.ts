// Request context (caller identity and tenant) shared by every API module, plus the recall contract error.

import { BadRequestError } from '../api-errors.js';
import type { HippoStore } from '../store-port.js';

/**
 * Actor identity + authorization role for a Context.
 *
 * Carries the audit-log subject plus a role for /v1/sleep admin gating. Audit
 * helpers take the bare `string`, so callers pass `ctx.actor.subject`. Role checks happen at the request
 * boundary (e.g. /v1/sleep), except in authCreate and authRevoke (ForbiddenError).
 */
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

/**
 * Helper for building process-local Actor values (admin and host admin),
 * used by CLI and CLI-run connector Context constructors so the role
 * boilerplate isn't repeated at every site. Bearer-authed callers (HTTP
 * /v1/*) construct Actor directly from the api_keys row's role column via
 * buildContextWithAuth in src/server.ts.
 */
export function adminActor(subject: string): Actor {
  return { subject, role: 'admin', hostAdmin: true };
}

/** The per-person key: an unowned key gets its own bucket by key id rather than sharing one. */
export function ownerOrSubject(actor: Actor): string {
  return actor.owner ?? actor.subject;
}

/**
 * Thrown by `api.recall` when a caller's options violate a recall contract
 * that has been opted into via env. Carries a stable `code` field for HTTP /
 * MCP / CLI render paths to discriminate without parsing the message.
 *
 * Codes:
 *   - 'fresh_tail_requires_session_id' — `freshTailCount > 0` AND no
 *     `freshTailSessionId` AND `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1`.
 *     Default behaviour (env unset) returns tenant-wide rows; the env gate
 *     is opt-in so multi-session tenants can fail loud instead of silently
 *     surfacing cross-session rows tagged `isFreshTail=true`.
 *   - 'invalid_scorer_window' — `opts.scorerWindow` is set to a non-positive,
 *     non-integer, or non-finite value. 0 would route through FTS/LIKE
 *     `LIMIT 0` and then an uncapped full-store fallback, so it is validated upfront.
 */
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
