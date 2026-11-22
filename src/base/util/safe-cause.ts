import { errorMessage } from './log.js';

const SAFE_CAUSE_DEPTH = 5;

function isText<T>(value: T): value is T & string {
  return typeof value === 'string';
}

function copyLink<E>(link: E, scrub: (text: string) => string, deeper: Error | undefined): Error {
  const copy = new Error(
    scrub(errorMessage(link)),
    deeper === undefined ? undefined : { cause: deeper },
  );
  copy.name = scrub(link instanceof Error ? link.name : 'NonError');
  const code = link instanceof Error && 'code' in link ? link.code : undefined;
  if (isText(code)) Object.assign(copy, { code: scrub(code) });
  copy.stack = `${copy.name}: ${copy.message}`;
  return copy;
}

function copyChain<E>(link: E, scrub: (text: string) => string, seen: ReadonlySet<unknown>): Error {
  const next = link instanceof Error ? link.cause : undefined;
  const room = seen.size < SAFE_CAUSE_DEPTH && next !== undefined && !seen.has(next);
  const deeper = room ? copyChain(next, scrub, new Set([...seen, next])) : undefined;
  return copyLink(link, scrub, deeper);
}

/** A fresh Error per link of the cause chain (five at most) with only a scrubbed name, message and
 * string code: `util.inspect` and logs print every own field, such as the reply bytes a parser keeps. */
export function safeCause<E>(cause: E, scrub: (text: string) => string): Error {
  return copyChain(cause, scrub, new Set([cause]));
}
