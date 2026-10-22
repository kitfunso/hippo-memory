import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isObjectLike } from '../../base/session/capture-contract.js';
import { envHealthProbeMs } from '../../base/util/env.js';
import { isJsonObject, parseJson } from '../../base/util/json.js';
import { tryReadJsonFile } from '../../host/json-file.js';
import { pidAlive } from '../../host/pid-alive.js';
import { tryParseUrl } from '../../base/util/net.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';

export interface ServerInfo {
  /**
   * Pidfile schema version; absent on pidfiles written before the field existed, which detectServer treats as legacy
   * and still accepts.
   */
  schema?: number;
  pid: number;
  port: number;
  url: string;
  started_at: string;
}

// Pidfile sits directly inside hippoRoot (the `.hippo` directory itself, as for openHippoDb), i.e.
// `${hippoRoot}/server.pid`.
const PIDFILE = 'server.pid';

/**
 * How long detectServer waits for the `/health` probe before treating the pidfile as stale; short because it fires only
 * when a pidfile exists with a live pid on loopback. HIPPO_HEALTH_PROBE_MS overrides it. */
const HEALTH_PROBE_TIMEOUT_MS = 300;

/**
 * Hard cap on the /health body detectServer buffers: a real payload is well under 1 KB, so a larger body means the
 * process on the recorded port is not hippo. */
const HEALTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * Loopback hosts a recorded pidfile url may point at (serve() only binds these); any other host is malformed or forged
 * and is not probed.
 */
const PIDFILE_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * The pidfile names a live process on loopback that did not answer /health in time: most likely a busy server, so a
 * caller must neither bypass it with a second writer nor start another server beside it. */
export class ServerUnresponsiveError extends Error {
  constructor(info: ServerInfo, probeMs: number, options?: ErrorOptions) {
    super(
      `a hippo server (pid ${info.pid}) is recorded at ${info.url} but did not answer /health within ${probeMs} ms; ` +
        `it may be busy. ` +
        'Retry shortly, raise HIPPO_HEALTH_PROBE_MS, or stop that server.',
      options,
    );
    this.name = 'ServerUnresponsiveError';
  }
}

/** A second serve() found a server on this store, or one that has claimed the pidfile and is still binding. */
export class ServerAlreadyRunningError extends Error {
  constructor(info: ServerInfo) {
    super(
      `hippo serve: already running ${info.port > 0 ? `on port ${info.port}` : 'on this store, still starting'} ` +
        `(pid ${info.pid}). Stop that server before starting another on the same hippoRoot.`,
    );
    this.name = 'ServerAlreadyRunningError';
  }
}

/** False when the pidfile's pid is dead or its url could not be one serve() wrote. */
function isLiveLoopbackTarget(info: ServerInfo): boolean {
  if (!pidAlive(info.pid)) return false;

  // The pid may have been reused and the recorded url is read from a forgeable file; serve() only binds loopback, so a
  // url that is not http on a loopback host and the recorded port is malformed or forged. Reject it before probing,
  // since the probe and any routed request can carry HIPPO_API_KEY.
  const probeUrl = tryParseUrl(info.url);
  if (probeUrl === undefined) return false;
  return (
    probeUrl.protocol === 'http:' &&
    PIDFILE_LOOPBACK_HOSTS.has(probeUrl.hostname.replace(/^\[(.*)\]$/, '$1')) &&
    probeUrl.port === String(info.port)
  );
}

/** The whole body as text, or null once it passes HEALTH_BODY_MAX_BYTES (the stream is then cancelled). */
async function readCappedBody(body: ReadableStream<Uint8Array>): Promise<string | null> {
  // Read the body under a hard byte cap: the process on info.url may not be hippo (pid reuse), so its response is
  // untrusted and never goes unbounded into a parser.
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

/**
 * True when fetch failed because nothing listens on the port (the error or its cause, or any address tried, is
 * ECONNREFUSED).
 */
function isConnectionRefused<E>(err: E): boolean {
  if (errorCode(err) === 'ECONNREFUSED') return true;
  const cause = err instanceof Error ? err.cause : undefined;
  if (errorCode(cause) === 'ECONNREFUSED') return true;
  return (
    cause instanceof AggregateError &&
    cause.errors.length > 0 &&
    cause.errors.every((e) => errorCode(e) === 'ECONNREFUSED')
  );
}

/** False for a /health body that is not an object (JSON null, a scalar) or reports another started_at. */
function reportsStartedAt<T>(body: T, startedAt: string): boolean {
  return isObjectLike(body) && 'started_at' in body && body.started_at === startedAt;
}

/**
 * True when /health on info.url reports the pidfile's started_at; unlinks the pidfile on any definitive mismatch and
 * throws ServerUnresponsiveError on a probe timeout. */
async function healthMatchesPidfile(hippoRoot: string, info: ServerInfo): Promise<boolean> {
  // Refusal, non-200 or a malformed body unlink the pidfile as stale. A timeout proves neither a dead server nor this
  // one, so it keeps the pidfile and throws.
  // Any other error keeps it and warns.
  const probeMs = envHealthProbeMs() ?? HEALTH_PROBE_TIMEOUT_MS;
  try {
    const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(probeMs) });
    if (!res.ok || !res.body) {
      removePidfile(hippoRoot);
      return false;
    }
    const raw = await readCappedBody(res.body);
    if (raw === null) {
      removePidfile(hippoRoot);
      return false;
    }
    if (!reportsStartedAt(JSON.parse(raw), info.started_at)) {
      removePidfile(hippoRoot);
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ServerUnresponsiveError(info, probeMs, { cause: err });
    }
    // A refusal or a non-JSON body proves no hippo server answers there; any other failure may be a live server, so the
    // file stays.
    if (isConnectionRefused(err) || err instanceof SyntaxError) {
      removePidfile(hippoRoot);
    } else {
      log.warn(
        `server pidfile ${join(hippoRoot, PIDFILE)} kept: the /health probe failed (${errorMessage(err)})`,
        errorFields(err),
      );
    }
    return false;
  }
}

/** JSON null, an array or a scalar parses cleanly but is no pidfile, so the shape is checked, not just the syntax. */
function isServerInfo<T>(value: T): value is T & ServerInfo {
  return (
    isObjectLike(value) &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'port' in value &&
    typeof value.port === 'number' &&
    'url' in value &&
    typeof value.url === 'string' &&
    'started_at' in value &&
    typeof value.started_at === 'string'
  );
}

/**
 * Returns the pidfile's ServerInfo if a live hippo server answers on the recorded url, else null (best-effort unlinking
 * of missing/stale/malformed pidfiles).
 * `process.kill(pid, 0)` rules out dead pids; GET /health must then return the pidfile's `started_at` (pids get
 * reused). Probes only if the pid is live.
 * Throws ServerUnresponsiveError when that probe times out. */
export async function detectServer(hippoRoot: string): Promise<ServerInfo | null> {
  const path = join(hippoRoot, PIDFILE);
  if (!existsSync(path)) return null;

  let info: ServerInfo;
  try {
    // A serve() still binding leaves an empty or port-0 claim: nothing answers yet, but a live claimant keeps the file.
    if (startingClaim(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isServerInfo(parsed)) throw new TypeError('it is not a JSON object with a pid, port, url and started_at');
    info = parsed;
  } catch (err) {
    log.warn(`server pidfile ${path} is unreadable (${errorMessage(err)}); removing it`, errorFields(err));
    removePidfile(hippoRoot);
    return null;
  }

  if (!isLiveLoopbackTarget(info)) {
    removePidfile(hippoRoot);
    return null;
  }

  return (await healthMatchesPidfile(hippoRoot, info)) ? info : null;
}

/** A claim written but not yet filled in is empty for an instant; it is only stale once it has sat that way. */
const EMPTY_CLAIM_STALE_MS = 5_000;

/** Creates the pidfile with exclusive create; false when one exists. Its port is 0 until writePidfile fills it. */
function tryCreateClaim(path: string, startedAt: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    const claim: ServerInfo = { schema: 1, pid: process.pid, port: 0, url: '', started_at: startedAt };
    writeSync(fd, JSON.stringify(claim));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The claim of a serve() that is still binding, or undefined when the file is a finished or stale pidfile. */
function startingClaim(path: string): ServerInfo | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw === '') {
      return Date.now() - statSync(path).mtimeMs < EMPTY_CLAIM_STALE_MS
        ? { pid: 0, port: 0, url: '', started_at: '' }
        : undefined;
    }
    const info = parseJson(raw);
    return isServerInfo(info) && info.port === 0 && pidAlive(info.pid) ? info : undefined;
  } catch (err) {
    // Expected: the file vanished after EEXIST, or it is corrupt and detectServer clears it.
    if (errorCode(err) === 'ENOENT' || err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/**
 * Takes the store's one-server lock before serve() binds: the pidfile is created with exclusive create, so of two boots
 * started together exactly one wins. On a clash a live or still-starting server refuses, and a stale pidfile is removed
 * by detectServer and the create retried once. Throws ServerAlreadyRunningError.
 */
export async function claimPidfile(hippoRoot: string, startedAt: string): Promise<void> {
  const path = join(hippoRoot, PIDFILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreateClaim(path, startedAt)) return;
    const starting = startingClaim(path);
    if (starting) throw new ServerAlreadyRunningError(starting);
    const live = await detectServer(hippoRoot);
    if (live) throw new ServerAlreadyRunningError(live);
  }
  const winner = startingClaim(path) ?? (await detectServer(hippoRoot));
  throw new ServerAlreadyRunningError(winner ?? { pid: 0, port: 0, url: '', started_at: '' });
}

/**
 * Atomically writes the pidfile (process-scoped temp file, then rename; atomic on POSIX and NTFS). `startedAt` comes
 * from the caller (`serve()`) so the pidfile and GET /health carry the same timestamp, which detectServer's liveness
 * probe compares. */
export function writePidfile(hippoRoot: string, opts: { port: number; url: string; startedAt: string }): void {
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
 * Best-effort pidfile removal that never throws, so shutdown paths can call it. Identity-blind: a shutdown that must
 * not clobber a newer server's pidfile uses removePidfileIfOwned. */
function removePidfile(hippoRoot: string): void {
  const path = join(hippoRoot, PIDFILE);
  try {
    unlinkSync(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    log.warn(`server pidfile ${path} could not be removed (${errorCode(err) || errorMessage(err)})`, errorFields(err));
  }
}

/**
 * Removes the pidfile ONLY when both `pid` and `started_at` match `owner`, so an older shutting-down server cannot
 * orphan a newer one; never throws.
 * Anything unreadable or malformed is "not provably mine" and left alone (detectServer unlinks it). Returns true iff
 * removed.
 */
export function removePidfileIfOwned(hippoRoot: string, owner: { pid: number; startedAt: string }): boolean {
  const path = join(hippoRoot, PIDFILE);
  const info = tryReadJsonFile(path);
  // A missing, unreadable, malformed or non-object pidfile, or one another server now owns, is not provably mine.
  if (!isJsonObject(info) || info.pid !== owner.pid || info.started_at !== owner.startedAt) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    // Gone since the read means another process removed it; any other failure leaves a file the caller should hear of.
    if (errorCode(err) !== 'ENOENT') log.warn(`could not remove the server pidfile ${path}`, errorFields(err));
    return false;
  }
}
