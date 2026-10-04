/** Leveled stderr logger. `HIPPO_LOG` picks the threshold (error, warn, info, debug); unset or unknown means warn. */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Extra key=value pairs appended to the line; `requestId` ties a line to one HTTP request. */
export interface LogFields {
  requestId?: string;
  [key: string]: string | number | boolean | undefined;
}

const RANK = { error: 0, warn: 1, info: 2, debug: 3 } as const satisfies Record<LogLevel, number>;

function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(RANK, value);
}

/** The active threshold, read on every call so a test or a long-lived server can change it without a restart. */
export function logThreshold(): LogLevel {
  const raw = process.env.HIPPO_LOG?.trim().toLowerCase() ?? '';
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

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (!isLevelEnabled(level)) return;
  process.stderr.write(`${formatLogLine(level, message, fields)}\n`);
}

const onceKeys = new Set<string>();

/** Write `message` at `level` the first time `key` is seen in this process; later calls are dropped. */
function once(key: string, level: LogLevel, message: string, fields?: LogFields): void {
  if (onceKeys.has(key)) return;
  onceKeys.add(key);
  write(level, message, fields);
}

export const log = {
  error: (message: string, fields?: LogFields): void => write('error', message, fields),
  warn: (message: string, fields?: LogFields): void => write('warn', message, fields),
  info: (message: string, fields?: LogFields): void => write('info', message, fields),
  debug: (message: string, fields?: LogFields): void => write('debug', message, fields),
  once,
} as const;

/** Message for a caught value of unknown shape. `cause` names the sanctioned unknown-input case (error-cause enrichment). */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Test hook: forget which once-keys have fired. */
export function resetLogOnce(): void {
  onceKeys.clear();
}
