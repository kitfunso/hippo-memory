import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { envHealthProbeMs } from '../util/env.js';

export interface ServerInfo {
  /** Pidfile schema version; absent on pidfiles written before the field existed, which detectServer treats as legacy and still accepts. */
  schema?: number;
  pid: number;
  port: number;
  url: string;
  started_at: string;
}

// Pidfile sits directly inside hippoRoot (the `.hippo` directory itself, as for openHippoDb), i.e. `${hippoRoot}/server.pid`.
const PIDFILE = 'server.pid';

/** How long detectServer waits for the `/health` probe before treating the pidfile as stale; short because it fires only when a pidfile exists with a live
 * pid on loopback. HIPPO_HEALTH_PROBE_MS overrides it. */
const HEALTH_PROBE_TIMEOUT_MS = 300;

/** Hard cap on the /health body detectServer buffers: a real payload is well under 1 KB, so a larger body means the process on the recorded port is not
 * hippo. */
const HEALTH_BODY_MAX_BYTES = 64 * 1024;

/** Loopback hosts a recorded pidfile url may point at (serve() only binds these); any other host is malformed or forged and is not probed. */
const PIDFILE_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** False when the pidfile's pid is dead or its url could not be one serve() wrote. */
function isLiveLoopbackTarget(info: ServerInfo): boolean {
  // Signal 0 throws if the pid is dead or owned by another user we cannot signal; either way, treat as stale.
  // process.kill(pid, 0) works cross-platform for the dead-pid case (OpenProcess + GetExitCodeProcess on Windows).
  try {
    process.kill(info.pid, 0);
  } catch {
    return false;
  }

  // The pid may have been reused and the recorded url is read from a forgeable file; serve() only binds loopback, so a url that is not http on a loopback
  // host and the recorded port is malformed or forged. Reject it before probing, since the probe and any routed request can carry HIPPO_API_KEY.
  let probeUrl: URL;
  try {
    probeUrl = new URL(info.url);
  } catch {
    return false;
  }
  return (
    probeUrl.protocol === 'http:' &&
    PIDFILE_LOOPBACK_HOSTS.has(probeUrl.hostname.replace(/^\[(.*)\]$/, '$1')) &&
    probeUrl.port === String(info.port)
  );
}

/** The whole body as text, or null once it passes HEALTH_BODY_MAX_BYTES (the stream is then cancelled). */
async function readCappedBody(body: ReadableStream<Uint8Array>): Promise<string | null> {
  // Read the body under a hard byte cap: the process on info.url may not be hippo (pid reuse), so its response is untrusted and never goes unbounded into a
  // parser.
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > HEALTH_BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return raw;
}

/** True when /health on info.url reports the pidfile's started_at; unlinks the pidfile on any definitive mismatch. */
async function healthMatchesPidfile(hippoRoot: string, info: ServerInfo): Promise<boolean> {
  // Confirm the answering process is this server by matching /health `started_at` against the pidfile; refusal, non-200 or a malformed body unlink the
  // pidfile as stale. A probe timeout is ambiguous (a live but busy server can miss the 300ms window), so it returns null WITHOUT unlinking.
  try {
    const res = await fetch(`${info.url}/health`, {
      signal: AbortSignal.timeout(envHealthProbeMs() ?? HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      removePidfile(hippoRoot);
      return false;
    }
    const raw = await readCappedBody(res.body);
    if (raw === null) {
      removePidfile(hippoRoot);
      return false;
    }
    const body: { started_at?: unknown } = JSON.parse(raw);
    if (body.started_at !== info.started_at) {
      removePidfile(hippoRoot);
      return false;
    }
    return true;
  } catch (err) {
    // A timeout is ambiguous (the server may be busy), so keep the pidfile; any other failure (refused, malformed body) is definitive: unlink as stale.
    // SAFETY: err's shape is unknown (catch clause); reading an optional .name property structurally is safe regardless of the actual type.
    if ((err as { name?: unknown })?.name !== 'TimeoutError') {
      removePidfile(hippoRoot);
    }
    return false;
  }
}

/** Returns the pidfile's ServerInfo if a live hippo server answers on the recorded url, else null (best-effort unlinking of missing/stale/malformed pidfiles).
 * `process.kill(pid, 0)` rules out dead pids; GET /health must then return the pidfile's `started_at` (pids get reused). Probes only if the pid is live. */
export async function detectServer(hippoRoot: string): Promise<ServerInfo | null> {
  const path = join(hippoRoot, PIDFILE);
  if (!existsSync(path)) return null;

  let info: ServerInfo;
  try {
    info = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    removePidfile(hippoRoot);
    return null;
  }

  if (!isLiveLoopbackTarget(info)) {
    removePidfile(hippoRoot);
    return null;
  }

  return (await healthMatchesPidfile(hippoRoot, info)) ? info : null;
}

/** Atomically writes the pidfile (process-scoped temp file, then rename; atomic on POSIX and NTFS). `startedAt` comes from the caller (`serve()`) so the
 * pidfile and GET /health carry the same timestamp, which detectServer's liveness probe compares. */
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

/** Best-effort pidfile removal, silent on any error so shutdown paths can call it. Identity-blind: a shutdown that must not clobber a newer server's pidfile
 * uses removePidfileIfOwned. */
export function removePidfile(hippoRoot: string): void {
  const path = join(hippoRoot, PIDFILE);
  try { unlinkSync(path); } catch { /* already gone or undeletable; the next detectServer probe re-checks */ }
}

/** Removes the pidfile ONLY when both `pid` and `started_at` match `owner`, so an older shutting-down server cannot orphan a newer one; never throws.
 * Anything unreadable or malformed is "not provably mine" and left alone (detectServer unlinks it). Returns true iff removed. */
export function removePidfileIfOwned(
  hippoRoot: string,
  owner: { pid: number; startedAt: string },
): boolean {
  const path = join(hippoRoot, PIDFILE);
  try {
    const info: ServerInfo = JSON.parse(readFileSync(path, 'utf8'));
    // A literal JSON `null` parses cleanly but throws on property access;
    // that lands in the catch below, which is the intended "not mine" path.
    if (info.pid !== owner.pid || info.started_at !== owner.startedAt) {
      return false; // a different server owns the pidfile now
    }
    unlinkSync(path);
    return true;
  } catch {
    // Missing, unreadable, malformed, or non-object pidfile, or an unlink
    // failure: none is a provable own-removal, so report not-removed.
    return false;
  }
}
