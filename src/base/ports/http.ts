/** How long one call may take and what it may replay; the adapter's retry defaults fill the
 * rest. */
export interface HttpCallPolicy {
  readonly timeoutMs: number;
  readonly retryTransport?: boolean;
  readonly maxDelayMs?: number;
}

export interface Http {
  send(url: string, init: RequestInit, policy: HttpCallPolicy): Promise<Response>;
}
