export interface RetryOpts {
  url: string;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export async function fetchWithRetry(opts: RetryOpts): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = opts.maxRetries ?? 3;
  let attempt = 0;
  while (true) {
    const r = await f(opts.url, opts.init);
    if (r.status !== 429) return r;
    if (attempt >= max) throw new Error(`rate-limited after ${attempt + 1} attempts: ${opts.url}`);
    const ra = r.headers.get('retry-after');
    const delaySec = ra ? Number(ra) : Math.pow(2, attempt);
    await sleep(Math.max(0, delaySec) * 1000);
    attempt++;
  }
}
