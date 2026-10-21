// The HTTP port: domain builds the request and reads the reply; src/infra/http.ts sends it.

/** How long one call may take and what it may replay; the adapter's retry defaults fill the rest. */
export interface HttpCallPolicy {
  /** Per-attempt limit; a stalled peer ends as a thrown `TimeoutError`, never a hang. */
  readonly timeoutMs: number;
  /** Replay a dropped connection or a timed-out attempt: only for a call that changes nothing on the far side. */
  readonly retryTransport?: boolean;
  /** A Retry-After longer than this hands the reply back at once. */
  readonly maxDelayMs?: number;
}

export interface Http {
  /** The reply to one request, with 429 and 5xx retried; throws when no reply arrives. */
  send(url: string, init: RequestInit, policy: HttpCallPolicy): Promise<Response>;
}
