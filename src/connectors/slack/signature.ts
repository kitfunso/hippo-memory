import { matchesHmacSha256 } from '../hmac.js';

const DEFAULT_SKEW_SECONDS = 5 * 60;

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

function verifyOne(
  rawBody: string | Uint8Array,
  signature: string,
  timestamp: string,
  secret: string,
): boolean {
  return matchesHmacSha256('v0=', [`v0:${timestamp}:`, rawBody], secret, signature);
}

export function verifySlackSignature(opts: VerifyOptions): boolean {
  const { rawBody, timestamp, signature, signingSecret, previousSecret } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > skew) return false;
  if (verifyOne(rawBody, signature, timestamp, signingSecret)) return true;
  if (previousSecret && verifyOne(rawBody, signature, timestamp, previousSecret)) return true;
  return false;
}
