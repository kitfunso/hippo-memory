// Request-body and path-segment validators shared by the /v1 route handlers.
import type { IncomingMessage } from 'node:http';
import type { Context, RememberOptions } from '../../api/index.js';
import { envBodyTimeoutMs } from '../../base/util/env.js';
import { bodyDeadlineMs, HttpError, readBody } from '../../base/util/http-util.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_ARRAY_ITEMS,
  MAX_ID_LEN,
  MAX_LIST_LIMIT,
  resolveListLimit,
} from '../../base/util/limits.js';
import { type JsonValue, isJsonString, isJsonObject } from '../../base/util/json.js';

// Runtime membership check for a `ReadonlySet<T>` of string-literal members: Set<T>.has gives no narrowing, so this is
// the one place the `as T` assertion lives and callers narrow via the `value is T` return.
export function isSetMember<T extends string>(set: ReadonlySet<T>, value: string): value is T {
  // SAFETY: `value as T` is discarded unless `set.has` (the real runtime check) confirms membership; the `value is T`
  // return type does the narrowing.
  return set.has(value as T);
}

export function parseListLimit(
  limitRaw: string | null,
  defaultLimit = DEFAULT_LIST_LIMIT,
  maxLimit = MAX_LIST_LIMIT,
): number {
  const limit = resolveListLimit(limitRaw === null ? undefined : Number(limitRaw), defaultLimit, maxLimit);
  if (limit === undefined) throw new HttpError(400, `limit must be a positive integer <= ${maxLimit}`);
  return limit;
}

/** An optional query number that must be above zero, or from zero when `allowZero`; absent is undefined. */
export function parseNumberParam(raw: string | null, name: string, allowZero = false): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new HttpError(400, `${name} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
  }
  return value;
}

/** An optional query integer in min..max, refused rather than clamped; absent is undefined. */
export function parseIntParam(raw: string | null, name: string, min: number, max: number): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be a positive integer between ${min} and ${max}`);
  }
  return value;
}

/** `_authed` is proof the caller passed auth, so a full-size body is read only for an authenticated caller; the key
 * mint reads under its own small cap. */
export async function parseJsonBody(req: IncomingMessage, _authed: Context): Promise<Record<string, JsonValue>> {
  return parseJsonObjectText(await readBody(req, { deadlineMs: bodyDeadlineMs(envBodyTimeoutMs()) }));
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

/** Absent (undefined or null) is undefined; a present value of the wrong type or over `max` characters is a 400. */
export function getString(obj: Record<string, JsonValue>, key: string, max: number): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!isJsonString(v)) throw new HttpError(400, `${key} must be a string`);
  if (v.length > max) throw new HttpError(400, `${key} exceeds ${max}-character cap`);
  return v;
}

export interface RequiredStringRule {
  readonly max: number;
  /** The field name is a plural noun, so the replies read "are required" and "exceed". */
  readonly plural?: boolean;
  /** The blank check does not trim, so a value of only spaces passes it. */
  readonly untrimmed?: boolean;
}

export function requiredString(body: Record<string, JsonValue>, key: string, rule: RequiredStringRule): string {
  const value = body[key];
  if (!isJsonString(value) || (rule.untrimmed ? value : value.trim()).length === 0) {
    throw new HttpError(400, `${key} ${rule.plural ? 'are' : 'is'} required (non-empty string)`);
  }
  if (value.length > rule.max) {
    throw new HttpError(400, `${key} ${rule.plural ? 'exceed' : 'exceeds'} ${rule.max}-character cap`);
  }
  return value;
}

export function getStringArray(
  obj: Record<string, JsonValue>,
  key: string,
  maxItems: number,
  maxItemLen: number,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every(isJsonString)) throw new HttpError(400, `${key} must be an array of strings`);
  if (v.length > maxItems) throw new HttpError(400, `${key} exceeds ${maxItems}-item cap`);
  if (v.some((item) => item.length > maxItemLen)) {
    throw new HttpError(400, `each ${key} entry exceeds ${maxItemLen}-character cap`);
  }
  return v;
}

/**
 * Keeps only `name` and `aliases`: a client's `legacy_name` is a folder name, which must never become a row's origin.
 */
export function getCallerProject(body: Record<string, JsonValue>): RememberOptions['project'] {
  const v = body.project;
  if (v === undefined || v === null) return undefined;
  if (!isJsonObject(v) || !isJsonString(v.name)) {
    throw new HttpError(400, 'project must be an object with a "name" string');
  }
  if (v.name.length > MAX_ID_LEN) throw new HttpError(400, `project.name exceeds ${MAX_ID_LEN}-character cap`);
  if (v.aliases === undefined) return { name: v.name };
  if (!Array.isArray(v.aliases) || !v.aliases.every(isJsonString)) {
    throw new HttpError(400, 'project.aliases must be an array of strings');
  }
  const aliases = getStringArray(v, 'aliases', MAX_ARRAY_ITEMS, MAX_ID_LEN);
  return { name: v.name, aliases };
}

/**
 * Charset + length validation for `:id` captures, called right after `matchPath` so empty/overlong/illegal ids get a
 * 400, not "not found".
 * Allows every production id shape (`mem_<hex>`, `sess-<id>`, Slack ids) plus `:` and `.`; no `/`, since
 * `rejectEncodedSlash` stops `%2F` smuggling.
 */
const ID_SEGMENT_RE = /^[A-Za-z0-9_:.-]+$/;
export function validateIdSegment(id: string, fieldName: string): void {
  if (id.length === 0) throw new HttpError(400, `${fieldName} is required`);
  if (id.length > MAX_ID_LEN) throw new HttpError(400, `${fieldName} exceeds ${MAX_ID_LEN}-character cap`);
  if (!ID_SEGMENT_RE.test(id)) {
    throw new HttpError(400, `${fieldName} contains invalid characters; allowed: A-Z a-z 0-9 _ : . -`);
  }
}
