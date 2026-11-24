import type { IncomingMessage } from 'node:http';
import { isPromise } from 'node:util/types';
import type { Actor } from '../../api/index.js';
import { frozenActor } from '../../api/frozen-actor.js';
import { HttpError } from '../../base/errors/http-errors.js';
import { type JsonValue, isJsonNumber, isJsonObject, isJsonString } from '../../base/util/json.js';
import { errorFields, log, type LogFields } from '../../base/util/log.js';
import { currentRequestId } from '../../base/util/request-scope.js';
import { MINUTE_MS } from '../../base/util/time.js';
import { LOCAL_KEY_SUBJECT } from './local-key.js';
import { parseRequest } from './request.js';
import type { KeyQuota } from './types.js';

const FAULT_LOG_EVERY_MS = MINUTE_MS;
// A huge finite wait would print as `1e+21`, which is not valid delta-seconds.
const MAX_RETRY_AFTER_SEC = 86_400;
let faultLoggedAt = Number.NEGATIVE_INFINITY;
// V8 throws RangeError when a joined log line passes its maximum string length; the cap also bounds the line.
const FAULT_FIELD_MAX = 8192;

// The logger prints a field with String() or JSON.stringify, which runs a plugin's toString or rejects a BigInt.
function plainFields(built: LogFields): LogFields {
  const plain: LogFields = {};
  for (const [key, value] of Object.entries(built)) {
    if (value !== undefined) plain[key] = String(value).slice(0, FAULT_FIELD_MAX);
  }
  return plain;
}

function quotaFault(what: string, fields?: () => LogFields): void {
  const now = Date.now();
  if (now >= faultLoggedAt && now - faultLoggedAt < FAULT_LOG_EVERY_MS) return;
  faultLoggedAt = now;
  const message = `key quota: ${what}; the request is admitted, and further faults this minute are not logged`;
  let plain: LogFields | undefined;
  try {
    plain = fields === undefined ? undefined : plainFields(fields());
  } catch {
    plain = { errorClass: 'unprintable' };
  }
  log.error(message, plain);
}

interface Refusal {
  readonly message: string;
  readonly seconds: number;
}

function refusalOf(answer: JsonValue | undefined): Refusal | null {
  if (!isJsonObject(answer)) return null;
  const { retryAfterSec, message } = answer;
  if (!isJsonNumber(retryAfterSec) || !Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    return null;
  }
  if (!isJsonString(message) || message === '') return null;
  return { message, seconds: Math.min(Math.ceil(retryAfterSec), MAX_RETRY_AFTER_SEC) };
}

export function askKeyQuota(
  req: IncomingMessage,
  tenantId: string,
  actor: Actor,
  quota: KeyQuota | undefined,
): void {
  if (quota === undefined) return;
  if (actor.subject === LOCAL_KEY_SUBJECT) return;
  const { method, path } = parseRequest(req);
  let answer: unknown;
  let refusal: Refusal | null;
  try {
    answer = quota({
      tenantId,
      actor: frozenActor(actor),
      method,
      path,
      requestId: currentRequestId(),
    });
    if (answer === null) return;
    // Mute a returned native promise so it cannot crash the process; Promise.resolve would adopt a thenable.
    // SHORTCUT: a promise whose `then` lookup throws (own constructor getter, subclass species, Proxy) still rejects
    // unhandled; off-contract. Upgrade path: an async hook contract awaited under a deadline.
    if (isPromise(answer)) Promise.prototype.then.call(answer, undefined, () => undefined);
    // SAFETY: a JS hook may return any value; refusalOf checks each field it reads.
    refusal = refusalOf(answer as JsonValue);
  } catch (err) {
    quotaFault('the hook threw', () => errorFields(err));
    return;
  }
  if (refusal === null) {
    quotaFault('the hook answered neither null nor a refusal');
    return;
  }
  throw new HttpError(429, refusal.message, refusal.seconds);
}
