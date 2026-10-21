import { MAX_BODY_BYTES } from './http-util.js';

// Cap for id-shaped request fields (ids, tenant, session, scope, class): far above real values, small enough to bound
// logs and indexes.
export const MAX_ID_LEN = 256;

// Longest session id or tool name a hook payload may put in a log row; the payload is not trusted to be short.
export const MAX_HOOK_FIELD_LEN = 128;

// Cap for short free-text request fields (names, text, context, change summaries, reasons), on HTTP and MCP alike.
export const MAX_SHORT_FIELD_LEN = 4096;

// A content-like field can be as long as the body that carries it.
export const MAX_CONTENT_LEN = MAX_BODY_BYTES;

// ISO dates and similar short stamps.
export const MAX_DATE_LEN = 64;

// Most entries a string-array field takes (tags, aliases).
export const MAX_ARRAY_ITEMS = 100;

// Page size every list surface (CLI, HTTP, store) falls back to when the caller names none.
export const DEFAULT_LIST_LIMIT = 100;

// Days of git history `hippo learn --git` and hippo_learn scan when the caller names none.
export const DEFAULT_LEARN_DAYS = 7;

// Ceiling for a caller-named list page; hippo.db's `LIMIT ?` and one response's size bound it, and every list surface
// shares it.
export const MAX_LIST_LIMIT = 1000;

export const MAX_AUDIT_LIMIT = 10_000;

// Cap on a reply body read from a peer (LLM API, hippo server, reranker); honest replies are a few KB, and 1 MiB
// leaves room for a verbose envelope.
export const MAX_REPLY_BYTES = 1024 * 1024;

/** The one list-limit rule: absent means the default; a positive integer up to the ceiling passes.
 * Anything else returns undefined, so each surface words its own error. */
export function resolveListLimit(
  requested: number | undefined,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  maxLimit: number = Infinity,
): number | undefined {
  if (requested === undefined) return defaultLimit;
  return Number.isInteger(requested) && requested > 0 && requested <= maxLimit ? requested : undefined;
}
