// Request-body and path-segment validators shared by the /v1 route handlers.
import { DEFAULT_LIST_LIMIT } from '../util/limits.js';
import type { IncomingMessage } from 'node:http';
import type { Context, RememberOpts } from '../api/index.js';
import { HttpError, MAX_ID_LEN, readBody } from '../util/http-util.js';
import { type JsonValue, isJsonString, isJsonObject } from '../util/json.js';

// Runtime membership check for a `ReadonlySet<T>` of string-literal members: Set<T>.has gives no narrowing, so this is the one place the `as T` assertion lives
// and callers narrow via the `value is T` return.
export function isSetMember<T extends string>(set: ReadonlySet<T>, value: string): value is T {
  // SAFETY: `value as T` is discarded unless `set.has` (the real runtime check) confirms membership; the `value is T` return type does the narrowing.
  return set.has(value as T);
}

// Cap for short free-text HTTP fields (names, text, context, change summaries) on the object routes.
export const MAX_SHORT_FIELD_LEN = 4096;

// Number.isInteger, not isFinite: SQLite `LIMIT ?` rejects "1.5" with a 500.
// Shared by every first-class-object list route so the guard cannot drift.
export const MAX_LIST_LIMIT = 1000;

export function parseListLimit(limitRaw: string | null, defaultLimit = DEFAULT_LIST_LIMIT, maxLimit = MAX_LIST_LIMIT): number {
  if (limitRaw === null) return defaultLimit;
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > maxLimit) {
    throw new HttpError(400, `limit must be a positive integer <= ${maxLimit}`);
  }
  return limit;
}

/** `_authed` is proof the caller passed auth, so a full-size body is read only for
 * an authenticated caller; the key mint reads under its own small cap. */
export async function parseJsonBody(req: IncomingMessage, _authed: Context): Promise<Record<string, JsonValue>> {
  return parseJsonObjectText(await readBody(req));
}

export function parseJsonObjectText(raw: string): Record<string, JsonValue> {
  if (raw.length === 0) return {};
  try {
    const parsed: JsonValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
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
  if (!isJsonObject(v) || !isJsonString(v.name)) {
    throw new HttpError(400, 'project must be an object with a "name" string');
  }
  if (v.aliases === undefined) return { name: v.name };
  if (!Array.isArray(v.aliases) || !v.aliases.every(isJsonString)) {
    throw new HttpError(400, 'project.aliases must be an array of strings');
  }
  return { name: v.name, aliases: v.aliases };
}

/** Charset + length validation for `:id` captures, called right after `matchPath` so empty/overlong/illegal ids get a 400, not "not found".
 * Allows every production id shape (`mem_<hex>`, `sess-<id>`, Slack ids) plus `:` and `.`; no `/`, since `rejectEncodedSlash` stops `%2F` smuggling. */
const ID_SEGMENT_RE = /^[A-Za-z0-9_:.-]+$/;
export function validateIdSegment(id: string, fieldName: string): void {
  if (id.length === 0) throw new HttpError(400, `${fieldName} is required`);
  if (id.length > MAX_ID_LEN) throw new HttpError(400, `${fieldName} exceeds ${MAX_ID_LEN}-character cap`);
  if (!ID_SEGMENT_RE.test(id)) {
    throw new HttpError(400, `${fieldName} contains invalid characters; allowed: A-Z a-z 0-9 _ : . -`);
  }
}
