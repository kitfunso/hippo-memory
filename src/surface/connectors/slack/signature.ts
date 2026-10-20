import { log } from '../../../base/util/log.js';
import { matchesHmacSha256 } from '../hmac.js';

const DEFAULT_SKEW_SECONDS = 5 * 60;
const SIGNATURE_HEADER_RE = /^v0=[0-9a-f]{64}$/;

function withinSkew(timestamp: string, now: number, skewSeconds: number): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(now - ts) <= skewSeconds;
}

const DATE_OR_ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Epoch ms of an ISO date (00:00 UTC) or timestamp, or null; a day that rolls over, as 2026-02-31, is no date. */
function untilMs(text: string): number | null {
  const ms = Date.parse(text);
  const day = text.slice(0, 10);
  const real =
    DATE_OR_ISO.test(text) &&
    Number.isFinite(ms) &&
    new Date(Date.parse(`${day}T00:00:00Z`)).toISOString().startsWith(day);
  return real ? ms : null;
}

/**
 * The previous signing secret while its rotation window is open. With no `until` it stays open, as before; at or past
 * `until`, or when `until` is no date, it is closed and one warning says so, so a secret left in the environment stops
 * working on the day the operator named.
 */
export function previousSecretInForce(
  previous: string | undefined,
  until: string | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (!previous) return undefined;
  if (until === undefined || until === '') return previous;
  const end = untilMs(until);
  if (end !== null && nowMs < end) return previous;
  log.once(
    'slack-previous-secret-closed',
    'warn',
    end === null
      ? 'SLACK_SIGNING_SECRET_PREVIOUS_UNTIL is not an ISO date, so SLACK_SIGNING_SECRET_PREVIOUS is refused'
      : `SLACK_SIGNING_SECRET_PREVIOUS expired at ${until} and is refused; remove it from the environment`,
  );
  return undefined;
}

/**
 * True for headers that could pass verifySlackSignature: a timestamp inside the skew window and a `v0=` signature of 64
 * hex digits. Anything else is refused before the body is read, since no secret can make it match.
 */
export function isWellFormedSlackRequest(
  timestamp: string,
  signature: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  return SIGNATURE_HEADER_RE.test(signature) && withinSkew(timestamp, now, DEFAULT_SKEW_SECONDS);
}

export interface VerifyOptions {
  /** The body's bytes as received; a string is hashed as its UTF-8 encoding. */
  rawBody: string | Uint8Array;
  timestamp: string;
  signature: string;
  signingSecret: string;
  /**
   * Previous signing secret during rotation (SLACK_SIGNING_SECRET_PREVIOUS); the verifier tries `signingSecret` first,
   * then this.
   */
  previousSecret?: string;
  /** Current unix seconds. Injectable for tests. */
  now?: number;
  /** Max allowed skew in seconds. Default 5 minutes (Slack's recommendation). */
  skewSeconds?: number;
}

function verifyOne(rawBody: string | Uint8Array, signature: string, timestamp: string, secret: string): boolean {
  return matchesHmacSha256('v0=', [`v0:${timestamp}:`, rawBody], secret, signature);
}

export function verifySlackSignature(opts: VerifyOptions): boolean {
  const { rawBody, timestamp, signature, signingSecret, previousSecret } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (!withinSkew(timestamp, now, skew)) return false;
  if (verifyOne(rawBody, signature, timestamp, signingSecret)) return true;
  if (previousSecret && verifyOne(rawBody, signature, timestamp, previousSecret)) return true;
  return false;
}
