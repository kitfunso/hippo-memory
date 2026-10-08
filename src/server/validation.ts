// Request-body and path-segment validators shared by the /v1 route handlers.
import type { IncomingMessage } from 'node:http';
import type { Context, RememberOpts } from '../api.js';
import { HttpError, isJsonObjectRecord, MAX_ID_LEN, readBody } from '../http-util.js';
import { type JsonValue, isJsonString } from '../json.js';

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

// Runtime membership check for a `ReadonlySet<T>` of string-literal union
// members, used at every `body` field validated against a VALID_* set below.
// Set<T>.has(value: T) itself gives no narrowing (its parameter type is T,
// not a type predicate) so callers previously needed a separate `as T` cast
// at both the check and the later usage; this helper is the one place that
// assertion lives, so downstream call sites narrow via the `value is T`
// return instead of re-asserting.
export function isSetMember<T extends string>(set: ReadonlySet<T>, value: string): value is T {
  // SAFETY: `value as T` is discarded unless `set.has` (the real runtime
  // check) confirms membership; the `value is T` return type is what
  // performs the actual narrowing for callers.
  return set.has(value as T);
}

// Number.isInteger, not isFinite: SQLite `LIMIT ?` rejects "1.5" with a 500.
// Shared by every first-class-object list route so the guard cannot drift.
export function parseListLimit(limitRaw: string | null, defaultLimit = 100, maxLimit = 1000): number {
  if (limitRaw === null) return defaultLimit;
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > maxLimit) {
    throw new HttpError(400, `limit must be a positive integer <= ${maxLimit}`);
  }
  return limit;
}

/** `_authed` is proof the caller passed auth, so a full-size body is read only for an authenticated caller; the key mint reads first under its own small cap. */
export async function parseJsonBody(req: IncomingMessage, _authed: Context): Promise<Record<string, JsonValue>> {
  return parseJsonObjectText(await readBody(req));
}

export function parseJsonObjectText(raw: string): Record<string, JsonValue> {
  if (raw.length === 0) return {};
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (!isJsonObjectRecord(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return parsed;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function getString(obj: Record<string, JsonValue>, key: string): string | undefined {
  const v = obj[key];
  return isJsonString(v) ? v : undefined;
}

export function getStringArray(obj: Record<string, JsonValue>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  if (!v.every(isJsonString)) return undefined;
  return v;
}

/** Keeps only `name` and `aliases`: a client's `legacy_name` is a folder name, which must never become a row's origin. */
export function getCallerProject(body: Record<string, JsonValue>): RememberOpts['project'] {
  const v = body.project;
  if (v === undefined || v === null) return undefined;
  if (!isJsonObjectRecord(v) || !isJsonString(v.name)) {
    throw new HttpError(400, 'project must be an object with a "name" string');
  }
  if (v.aliases === undefined) return { name: v.name };
  if (!Array.isArray(v.aliases) || !v.aliases.every(isJsonString)) {
    throw new HttpError(400, 'project.aliases must be an array of strings');
  }
  return { name: v.name, aliases: v.aliases };
}

/**
 * Charset + length validation for `:id` route captures. Routes call
 * this immediately after `matchPath` to reject empty / overlong / illegal
 * ids with a useful 400 instead of silently falling through to "not found".
 *
 * Allowed charset matches all production id shapes Hippo emits: `mem_<hex>`,
 * `sum_<hex>`, `sess-<id>`, Slack bot ids like `B01ABCD`, etc. The `:` and
 * `.` are allowed for forward-compat. The `/` is intentionally absent —
 * Hippo never emits ids with slashes, and `rejectEncodedSlash` already
 * stops `%2F`-smuggled ones at the front door.
 */
const ID_SEGMENT_RE = /^[A-Za-z0-9_:.\-]+$/;
export function validateIdSegment(id: string, fieldName: string): void {
  if (id.length === 0) throw new HttpError(400, `${fieldName} is required`);
  if (id.length > MAX_ID_LEN) throw new HttpError(400, `${fieldName} exceeds ${MAX_ID_LEN}-character cap`);
  if (!ID_SEGMENT_RE.test(id)) {
    throw new HttpError(400, `${fieldName} contains invalid characters; allowed: A-Z a-z 0-9 _ : . -`);
  }
}
