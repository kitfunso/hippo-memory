/** Leveled stderr logger. `HIPPO_LOG` picks the threshold (error, warn, info,
 * debug); unset or unknown means warn. `HIPPO_LOG_FORMAT=json` writes JSON lines. */

import { envLogJson, envLogLevel } from './env.js';
import { currentRequestId } from './request-scope.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Extra key=value pairs appended to the line. `ts` and, inside a request, `requestId` are added to every line written. */
export interface LogFields {
  ts?: string;
  requestId?: string;
  [key: string]: string | number | boolean | undefined;
}

const RANK = { error: 0, warn: 1, info: 2, debug: 3 } as const satisfies Record<LogLevel, number>;

function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(RANK, value);
}

/** The active threshold, read on every call so a test or a long-lived server can change it without a restart. */
export function logThreshold(): LogLevel {
  const raw = envLogLevel();
  return isLogLevel(raw) ? raw : 'warn';
}

export function isLevelEnabled(level: LogLevel): boolean {
  return RANK[level] <= RANK[logThreshold()];
}

// A field value is caller data; flattening newlines keeps one event on one line.
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');

/** Same `[hippo] ` prefix the existing stderr lines use, so default-level output reads as before. */
export function formatLogLine(level: LogLevel, message: string, fields: LogFields = {}): string {
  const extras = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}=${oneLine(String(v))}`)
    .join('');
  return `[hippo] ${level}: ${oneLine(message)}${extras}`;
}

/** One JSON object per line for a log collector; JSON escaping keeps a multi-line value on the one line. */
export function formatLogJson(level: LogLevel, message: string, fields: LogFields = {}): string {
  const { ts, ...rest } = fields;
  return JSON.stringify({ ts, level, msg: message, ...rest });
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (!isLevelEnabled(level)) return;
  // The request id is ambient, so a line logged deep in a library call still names the request it ran for.
  const stamped: LogFields = { ts: new Date().toISOString(), requestId: currentRequestId(), ...fields };
  const format = envLogJson() ? formatLogJson : formatLogLine;
  process.stderr.write(`${format(level, message, stamped)}\n`);
}

const onceKeys = new Set<string>();

/** Write `message` at `level` the first time `key` is seen in this process; later calls are dropped. */
function once(key: string, level: LogLevel, message: string, fields?: LogFields): void {
  if (onceKeys.has(key)) return;
  onceKeys.add(key);
  write(level, message, fields);
}

/** Warn the first time `key` is seen in this process, then log at debug, so a repeating failure stays findable without flooding stderr. */
function warnThenDebug(key: string, message: string, fields?: LogFields): void {
  const level = onceKeys.has(key) ? 'debug' : 'warn';
  onceKeys.add(key);
  write(level, message, fields);
}

/** The class name and stack of a thrown value, as log fields; a non-Error throw has no stack. */
export function errorFields<E>(err: E): LogFields {
  if (!(err instanceof Error)) return { errorClass: 'NonError' };
  return { errorClass: err.constructor.name, stack: err.stack };
}

export const log = {
  error: (message: string, fields?: LogFields): void => write('error', message, fields),
  warn: (message: string, fields?: LogFields): void => write('warn', message, fields),
  info: (message: string, fields?: LogFields): void => write('info', message, fields),
  debug: (message: string, fields?: LogFields): void => write('debug', message, fields),
  once,
  warnThenDebug,
} as const;

/** Message for a caught value of unknown shape. `cause` names the sanctioned unknown-input case (error-cause enrichment). */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Test hook: forget which once-keys have fired. */
export function resetLogOnce(): void {
  onceKeys.clear();
}
