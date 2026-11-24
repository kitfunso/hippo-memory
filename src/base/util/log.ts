import { envLogJson, envLogLevel } from './env.js';
import { currentRequestId } from './request-scope.js';
import { redactSecretsStrict } from './secret-detect.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Extra key=value pairs appended to the line. `ts` and, inside a request, `requestId` are added to
 * every line written.
 */
export interface LogFields {
  ts?: string;
  requestId?: string;
  [key: string]: string | number | boolean | undefined;
}

const RANK = { error: 0, warn: 1, info: 2, debug: 3 } as const satisfies Record<LogLevel, number>;

function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(RANK, value);
}

function logThreshold(): LogLevel {
  const raw = envLogLevel();
  return isLogLevel(raw) ? raw : 'warn';
}

export function isLevelEnabled(level: LogLevel): boolean {
  return RANK[level] <= RANK[logThreshold()];
}

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');

const fieldValue = (value: string): string =>
  /[\s"=]/.test(value) ? JSON.stringify(value) : value;

/** One line to a hook's own log file; `fields` carries a caught error's errorFields. */
export type LineLog = (line: string, opts?: { readonly fields?: LogFields }) => void;

/** ` key=value` for each defined field, for a line a side file writes itself. */
export function formatFields(fields: LogFields = {}): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}=${fieldValue(oneLine(String(v)))}`)
    .join('');
}

/** Same `[hippo] ` prefix the existing stderr lines use, so default-level output reads as
 * before. */
export function formatLogLine(level: LogLevel, message: string, fields: LogFields = {}): string {
  const extras = formatFields(fields);
  return `[hippo] ${level}: ${oneLine(message)}${extras}`;
}

/** One JSON object per line for a log collector; JSON escaping keeps a multi-line value on the
 * one line. */
export function formatLogJson(level: LogLevel, message: string, fields: LogFields = {}): string {
  const { ts, ...rest } = fields;
  return JSON.stringify({ ts, level, msg: message, ...rest });
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  if (isLevelEnabled(level)) emit(level, message, fields);
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const stamped: LogFields = {
    ts: new Date().toISOString(),
    requestId: currentRequestId(),
    ...fields,
  };
  const format = envLogJson() ? formatLogJson : formatLogLine;
  process.stderr.write(`${format(level, message, stamped)}\n`);
}

const ONCE_KEY_CAP = 1_000;
const onceKeys = new Set<string>();
let onceCapReported = false;

function sightOnceKey(key: string): 'new' | 'seen' {
  if (onceKeys.has(key)) {
    // Re-inserting moves the key last in Set order, so Set order tracks least recently seen.
    onceKeys.delete(key);
    onceKeys.add(key);
    return 'seen';
  }
  if (onceKeys.size >= ONCE_KEY_CAP) {
    const oldest = onceKeys.values().next();
    if (!oldest.done) {
      onceKeys.delete(oldest.value);
      repeatCounts.delete(oldest.value);
    }
    if (!onceCapReported) {
      onceCapReported = true;
      write(
        'warn',
        `log: ${ONCE_KEY_CAP} once-only warnings were written; the least recently seen are now forgotten`,
      );
    }
  }
  onceKeys.add(key);
  return 'new';
}

function once(key: string, level: LogLevel, message: string, fields?: LogFields): void {
  if (sightOnceKey(key) === 'new') write(level, message, fields);
}

function warnThenDebug(key: string, message: string, fields?: LogFields): void {
  write(sightOnceKey(key) === 'new' ? 'warn' : 'debug', message, fields);
}

const SAMPLE_EVERY = 100;
const repeatCounts = new Map<string, number>();

function warnThenSample(key: string, message: string, fields?: LogFields): void {
  if (sightOnceKey(key) === 'new') {
    write('warn', message, fields);
    return;
  }
  const seen = (repeatCounts.get(key) ?? 0) + 1;
  repeatCounts.set(key, seen);
  if (seen % SAMPLE_EVERY === 0) {
    write('warn', `${message} (${seen} more since the first warning)`, fields);
  } else write('debug', message, fields);
}

const CAUSE_DEPTH = 5;

function causeChain(err: Error): string | undefined {
  const seen = new Set<unknown>([err]);
  const links: string[] = [];
  let next: unknown = err.cause;
  while (next !== undefined && links.length < CAUSE_DEPTH && !seen.has(next)) {
    seen.add(next);
    links.push(
      next instanceof Error
        ? `${next.constructor.name}: ${next.message}`
        : `NonError: ${String(next)}`,
    );
    next = next instanceof Error ? next.cause : undefined;
  }
  return links.length > 0 ? links.join(' <- ') : undefined;
}

const VALUE_PREVIEW_CHARS = 200;

function valuePreview<E>(value: E): string {
  let text: string;
  try {
    text = value instanceof Object ? JSON.stringify(value) : String(value);
  } catch {
    return '(unprintable)';
  }
  const redacted = redactSecretsStrict(text ?? String(value));
  return redacted.length > VALUE_PREVIEW_CHARS
    ? `${redacted.slice(0, VALUE_PREVIEW_CHARS)}...`
    : redacted;
}

/** The class name, stack and cause chain of a thrown value, as log fields; a non-Error throw has
 * no stack but a short preview of the value. Both texts repeat the message, so `scrub` runs over
 * them where the message is redacted. */
export function errorFields<E>(
  err: E,
  scrub: (text: string) => string = (text) => text,
): LogFields {
  if (!(err instanceof Error)) return { errorClass: 'NonError', value: scrub(valuePreview(err)) };
  const cause = causeChain(err);
  return {
    errorClass: err.constructor.name,
    stack: err.stack === undefined ? undefined : scrub(err.stack),
    cause: cause === undefined ? undefined : scrub(cause),
  };
}

/** The class and errno name of a thrown value without its text, for a line that must not carry
 * caller data. */
export function errorClassFields<E>(err: E): LogFields {
  if (!(err instanceof Error)) return { errorClass: 'NonError' };
  const code = errorCode(err);
  return code === ''
    ? { errorClass: err.constructor.name }
    : { errorClass: err.constructor.name, errno: code };
}

let requestTrailOn = false;

/** A server process calls this at start, so its per-request lines write by default. A set
 * `HIPPO_LOG` still decides, and CLI and hook processes never call it. */
export function enableRequestTrail(): void {
  requestTrailOn = true;
}

function trail(message: string, fields?: LogFields): void {
  if (isLevelEnabled('info') || (requestTrailOn && !isLogLevel(envLogLevel()))) {
    emit('info', message, fields);
  }
}

export const log = {
  error: (message: string, fields?: LogFields): void => write('error', message, fields),
  warn: (message: string, fields?: LogFields): void => write('warn', message, fields),
  info: (message: string, fields?: LogFields): void => write('info', message, fields),
  debug: (message: string, fields?: LogFields): void => write('debug', message, fields),
  trail,
  once,
  warnThenDebug,
  warnThenSample,
} as const;

/** Message for a caught value of unknown shape. `cause` names the sanctioned unknown-input case
 * (error-cause enrichment). */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The text of an error the caller's classifier named as expected, for its one debug line.
 * Nothing is wrong, so the line leaves the stack out; check-caught-error-logs accepts this at
 * debug level only. */
export function expectedErrorText<E>(err: E): string {
  return errorMessage(err);
}

/** One post-compact failure, told once to the hook's output (`say`) and once to the structured
 * log. */
export function reportCompactionFailure(
  say: (message: string) => void,
  step: string,
  reason: string,
  fields?: LogFields,
): void {
  say(`${step} failed: ${reason}`);
  log.error(`post-compact: ${step} failed: ${reason}`, fields);
}

/** The string `code` of a caught value (an errno name such as EACCES), or '' when it has none. */
export function errorCode(cause: unknown): string {
  return cause instanceof Error && 'code' in cause ? String(cause.code) : '';
}
