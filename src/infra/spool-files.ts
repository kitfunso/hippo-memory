// The spool folder's name grammar (stems, claim and tmp patterns) and the busy-retrying fs steps
// every spool module shares.
import { MINUTE_MS } from '../base/util/time.js';
import { errorCode, errorFields, errorMessage, type LogFields } from '../base/util/log.js';
import { PRIVATE_DIR } from '../host/private-dir.js';

const STAMP_DIGITS = 13;

export const SPOOL_DIR = 'compactions-spool';
/**
 * Starts the log line of a step that broke with an unexpected error, so the session-start banner
 * counts it; a set-aside file is counted by its `.bad` name instead. */
export const SPOOL_PROBLEM = 'spool problem: ';
/** Long enough that a live replayer has finished with its claim. */
export const STALE_MS = 10 * MINUTE_MS;
export const MAX_ATTEMPTS = 3;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 50;
// Antivirus, the indexer or a delete still pending on Windows: the step is left for a later run.
export const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

// A stem is `<ms13>-<rand8hex>`, so name order is age order; legacy files are
// `<session>-<ms>.json`.
export const WAITING = /^([\w-]+)(?:\.a(\d+))?\.json$/;
const CLAIM = /^([\w-]+)\.a(\d+)\.claim-(\d{13})$/;
// An old binary's claim carries no claim time, so its mtime stands in.
const LEGACY_CLAIM = /^([\w-]+)(?:\.a(\d+))?\.json\.claimed$/;
export const TMP = /^([\w-]+)(?:\.a\d+)?\.json\.tmp$/;
export const BAD = /^([\w-]+)\.(?:\w+\.)?bad$/;
export const BAD_TMP = /^[\w-]+\.\w+\.bad\.[0-9a-f]{8}\.tmp$/;
export const NEW_STEM = /^(\d{13})-[0-9a-f]{8}$/;
const LEGACY_STEM_TIME = /-(\d+)$/;

/** Where a compaction step's lines go: the hook's log file, or a sleep's warnings. */
export type Log = (message: string, fields?: LogFields) => void;

/** Only the fs calls the spool makes, so a test can stand in for one of them. */
export interface SpoolFs {
  existsSync(file: string): boolean;
  mkdirSync(dir: string, options: typeof PRIVATE_DIR): void;
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
  renameSync(from: string, to: string): void;
  statSync(file: string): { mtimeMs: number };
  unlinkSync(file: string): void;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; flag?: 'wx' }): void;
}

type Settled = 'done' | 'gone' | 'busy';

/** One fs step's outcome: the value it returned once it ran, else the error code that ended it. */
type SettledStep<T> =
  | { readonly settled: 'done'; readonly code: ''; readonly value: T }
  | { readonly settled: 'gone' | 'busy'; readonly code: string; readonly value?: undefined };

export interface Waiting {
  name: string;
  stem: string;
  attempt: number;
  created: number;
}

export interface Claim {
  name: string;
  stem: string;
  attempt: number;
  /** null for a legacy claim, which is aged by mtime. */
  claimedAt: number | null;
}

export const stamp = (ms: number): string => String(Math.trunc(ms)).padStart(STAMP_DIGITS, '0');
const idle = new Int32Array(new SharedArrayBuffer(4));

/**
 * Runs one fs step, retrying a busy code briefly: its value once it ran, else the busy code it
 * kept hitting. Any other error throws.
 */
export function retryBusy<T>(step: () => T): { readonly value: T } | { readonly busyCode: string } {
  for (let retry = 0; ; retry++) {
    try {
      return { value: step() };
    } catch (err) {
      const code = errorCode(err);
      if (!BUSY_CODES.has(code)) throw err;
      if (retry === BUSY_RETRIES) return { busyCode: code };
      Atomics.wait(idle, 0, 0, BUSY_WAIT_MS);
    }
  }
}

/**
 * Runs one fs step: ENOENT means gone, a busy code is retried briefly, and any other error is
 * logged and counted busy, so a replay never throws.
 */
export function settleCode<T>(step: () => T, log: Log, what: string): SettledStep<T> {
  try {
    const ran = retryBusy(step);
    return 'value' in ran ? done(ran.value) : { settled: 'busy', code: ran.busyCode };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { settled: 'gone', code };
    log(`${SPOOL_PROBLEM}${what}: ${errorMessage(err)}`, { ...errorFields(err), errno: code });
    return { settled: 'busy', code };
  }
}

/** A step that needed no fs call, as one that ran. */
export function done<T>(value: T): SettledStep<T> {
  return { settled: 'done', code: '', value };
}

/** {@link settleCode} for a caller that needs only the outcome. */
export function settle(step: () => void, log: Log, what: string): Settled {
  return settleCode(step, log, what).settled;
}

/** When a stem was spooled: the time that leads a new stem, else the time that ends a legacy
 * one, else 0. */
export function created(stem: string): number {
  const m = NEW_STEM.exec(stem) ?? LEGACY_STEM_TIME.exec(stem);
  return m === null ? 0 : Number(m[1]);
}

/** Files waiting for import, oldest first across new and legacy names. */
export function waitingFiles(names: readonly string[]): Waiting[] {
  const found = names.flatMap((name) => {
    const m = WAITING.exec(name);
    return m === null
      ? []
      : [{ name, stem: m[1], attempt: Number(m[2] ?? 0), created: created(m[1]) }];
  });
  return found.sort(
    (a, b) => a.created - b.created || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export function claimOf(name: string): Claim | null {
  const m = CLAIM.exec(name);
  if (m !== null) return { name, stem: m[1], attempt: Number(m[2]), claimedAt: Number(m[3]) };
  const legacy = LEGACY_CLAIM.exec(name);
  return legacy === null
    ? null
    : { name, stem: legacy[1], attempt: Number(legacy[2] ?? 0), claimedAt: null };
}
