import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerInfo {
  /**
   * Pidfile schema version (L3). Absent on pidfiles written before this
   * field existed — detectServer treats a missing `schema` as legacy and
   * still accepts the pidfile.
   */
  schema?: number;
  pid: number;
  port: number;
  url: string;
  started_at: string;
}

// Pidfile sits directly inside hippoRoot. `hippoRoot` is the `.hippo`
// directory itself (the same convention used by api.ts / store.ts /
// openHippoDb), so this resolves to `${hippoRoot}/server.pid`.
const PIDFILE = 'server.pid';

/**
 * How long detectServer waits for the `/health` liveness probe before
 * treating the pidfile as stale. Short by design: the probe only fires on
 * the rare path where a pidfile exists and its pid is live, and the target
 * is always loopback, so a healthy server answers well within this bound.
 */
const HEALTH_PROBE_TIMEOUT_MS = 300;

/**
 * Hard cap on the /health response body detectServer will buffer. A real
 * hippo /health payload is well under 1 KB; a larger body means the process
 * answering on the recorded port is not hippo, so the pidfile is stale.
 */
const HEALTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * Loopback hosts the recorded pidfile url is allowed to point at. serve()
 * only binds these (it mirrors LOOPBACK_HOSTS in server.ts); a pidfile url
 * with any other host is malformed or forged and must not be probed.
 */
const PIDFILE_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Read .hippo/server.pid and return the embedded ServerInfo if a live hippo
 * server is genuinely answering on the recorded url. Returns null on missing,
 * malformed, or stale pidfiles, and best-effort unlinks the file in the
 * stale/malformed cases.
 *
 * Liveness is proven in two steps. `process.kill(pid, 0)` rules out dead
 * pids. But a pid can be reused by an unrelated process, so a GET /health
 * then confirms the process that answers is *this* hippo server: its
 * `started_at` must equal the pidfile's. A mismatch, non-200, malformed
 * body, or timeout all mean the pidfile is stale.
 *
 * The /health probe runs only when a pidfile exists and the pid is live, so
 * the common no-server path stays a single fast file existence check.
 */
export async function detectServer(hippoRoot: string): Promise<ServerInfo | null> {
  const path = join(hippoRoot, PIDFILE);
  if (!existsSync(path)) return null;

  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }

  // Probe the process. Sending signal 0 throws if the pid is dead or owned
  // by another user we cannot signal. Either way, treat as stale.
  // Node's process.kill(pid, 0) is implemented on Windows via OpenProcess +
  // GetExitCodeProcess, so this works cross-platform for the dead-pid case.
  try {
    process.kill(info.pid, 0);
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }

  // The pid is live, but it may have been reused by an unrelated process, and
  // the recorded url is read from a file anyone could forge. serve() only ever
  // binds a loopback host, so a url that is not http on a loopback host and the
  // recorded port is malformed or forged. Reject it before probing: the probe,
  // and the routed request that may follow, can carry HIPPO_API_KEY.
  let probeUrl: URL;
  try {
    probeUrl = new URL(info.url);
  } catch {
    try { unlinkSync(path); } catch {}
    return null;
  }
  if (
    probeUrl.protocol !== 'http:' ||
    !PIDFILE_LOOPBACK_HOSTS.has(probeUrl.hostname) ||
    probeUrl.port !== String(info.port)
  ) {
    try { unlinkSync(path); } catch {}
    return null;
  }

  // Confirm the process answering on info.url is this hippo server by matching
  // the /health `started_at` against the pidfile. A connection refusal, a
  // non-200, or a malformed body unlink the pidfile as stale. A probe timeout
  // is deliberately left ambiguous: a live but momentarily-busy server (e.g.
  // blocked on a synchronous query) can miss the 300ms window, so a timeout
  // returns null WITHOUT unlinking. The pidfile survives for the next probe.
  try {
    const res = await fetch(`${info.url}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      try { unlinkSync(path); } catch {}
      return null;
    }
    // Read the body under a hard byte cap. The process answering on info.url
    // may not be hippo (pid reuse is the case this probe guards against), so
    // its response is untrusted: never hand an unbounded stream to a parser.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > HEALTH_BODY_MAX_BYTES) {
        await reader.cancel();
        try { unlinkSync(path); } catch {}
        return null;
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const body = JSON.parse(raw) as { started_at?: unknown };
    if (body.started_at !== info.started_at) {
      try { unlinkSync(path); } catch {}
      return null;
    }
  } catch (err) {
    // A timeout is ambiguous (the server may be alive but busy), so keep the
    // pidfile. Any other failure (connection refused, malformed body) is
    // definitive: unlink it as stale.
    if ((err as { name?: unknown })?.name !== 'TimeoutError') {
      try { unlinkSync(path); } catch {}
    }
    return null;
  }

  return info;
}

/**
 * Atomically write the pidfile. Writes to a process-scoped temp file then
 * renames into place, which is atomic on POSIX and on NTFS via MoveFileEx.
 *
 * `startedAt` is supplied by the caller (`serve()`) rather than generated
 * here, so the pidfile and the server's GET /health response carry the same
 * timestamp — detectServer's liveness probe compares the two for equality.
 */
export function writePidfile(
  hippoRoot: string,
  opts: { port: number; url: string; startedAt: string },
): void {
  const path = join(hippoRoot, PIDFILE);
  const tmp = `${path}.tmp.${process.pid}`;
  const info: ServerInfo = {
    schema: 1,
    pid: process.pid,
    port: opts.port,
    url: opts.url,
    started_at: opts.startedAt,
  };
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, path);
}

/**
 * Best-effort pidfile removal. Silent on ENOENT or any other error so the
 * caller can use this in shutdown paths without fear of throwing.
 */
export function removePidfile(hippoRoot: string): void {
  const path = join(hippoRoot, PIDFILE);
  try { unlinkSync(path); } catch {}
}
