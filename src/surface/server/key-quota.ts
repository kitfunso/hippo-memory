// serve's keyQuota hook: asked after the per-caller charge, so only admitted requests reach it.
// It fails open: a quota guards load, not access.
import type { IncomingMessage } from 'node:http';
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
// One slot for the process: a broken meter faults on every request, and a line a minute shows it.
let faultLoggedAt = Number.NEGATIVE_INFINITY;

function quotaFault(what: string, fields?: LogFields): void {
  const now = Date.now();
  if (now - faultLoggedAt < FAULT_LOG_EVERY_MS) return;
  faultLoggedAt = now;
  log.error(
    `key quota: ${what}; the request is admitted, and further faults this minute are not logged`,
    fields,
  );
}

interface Refusal {
  readonly message: string;
  readonly seconds: number;
}

function refusalOf(answer: JsonValue | undefined): Refusal | null {
  if (!isJsonObject(answer)) return null;
  // Each field is read once: a getter on plugin code could answer differently the second time.
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
  // The operator's own CLI on this host is never metered.
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
    // Every read of the answer runs plugin getters, so all of it sits inside the guard.
    // keyQuota is synchronous; a JS hook that returns a promise must not crash the process with an
    // unhandled rejection.
    void Promise.resolve(answer).then(undefined, () => undefined);
    // SAFETY: a JS hook may return any value; refusalOf checks each field it reads.
    refusal = refusalOf(answer as JsonValue);
  } catch (err) {
    quotaFault('the hook threw', errorFields(err));
    return;
  }
  if (refusal === null) {
    quotaFault('the hook answered neither null nor a refusal');
    return;
  }
  // Outside the try, so the 429 is never taken for a fault.
  throw new HttpError(429, refusal.message, refusal.seconds);
}
