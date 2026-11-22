import { errorMessage } from './log.js';

const SAFE_CAUSE_DEPTH = 5;
const UNREADABLE_MESSAGE = 'the message could not be read';
const UNREADABLE_NAME = 'UnreadableError';
const UNREADABLE_CODE = 'UNREADABLE';
const UNREADABLE_CAUSE = 'the cause could not be read';

type Scrub = (text: string) => string;

function isText<T>(value: T): value is T & string {
  return typeof value === 'string';
}

// A getter or a null-prototype value can throw on any read, and the copy must still come back.
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function copyName<E>(link: E, scrub: Scrub): string {
  return guarded(
    () => scrub(String(link instanceof Error ? link.name : 'NonError')),
    UNREADABLE_NAME,
  );
}

function copyCode<E>(link: E, scrub: Scrub): string | undefined {
  return guarded(() => {
    const code = link instanceof Error && 'code' in link ? link.code : undefined;
    return isText(code) ? scrub(code) : undefined;
  }, UNREADABLE_CODE);
}

function copyLink<E>(link: E, scrub: Scrub, deeper: Error | undefined): Error {
  const message = guarded(() => scrub(errorMessage(link)), UNREADABLE_MESSAGE);
  const copy = new Error(message, deeper === undefined ? undefined : { cause: deeper });
  copy.name = copyName(link, scrub);
  const code = copyCode(link, scrub);
  if (code !== undefined) Object.assign(copy, { code });
  copy.stack = `${copy.name}: ${copy.message}`;
  return copy;
}

function copyChain<E>(link: E, scrub: Scrub, seen: ReadonlySet<unknown>): Error {
  const next = guarded(
    () => (link instanceof Error ? link.cause : undefined),
    new Error(UNREADABLE_CAUSE),
  );
  const room = seen.size < SAFE_CAUSE_DEPTH && next !== undefined && !seen.has(next);
  const deeper = room ? copyChain(next, scrub, new Set([...seen, next])) : undefined;
  return copyLink(link, scrub, deeper);
}

/** A fresh Error per link of the cause chain (five at most) with only a scrubbed name, message and
 * string code: `util.inspect` and logs print every own field, such as the reply bytes a parser keeps.
 * It never throws: a field that cannot be read becomes a fixed text. */
export function safeCause<E>(cause: E, scrub: Scrub): Error {
  return copyChain(cause, scrub, new Set([cause]));
}
