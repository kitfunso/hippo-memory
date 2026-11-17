// The messages a person typed in a session, as capture items: each one whole, so a fact told in
// chat can be recalled later even when it states no rule.
import { createHash } from 'node:crypto';
import { USER_MESSAGE_TAG } from '../../base/memory/entry.js';
import { ID_SUFFIX_CHARS } from '../../base/util/token-text.js';
import { truncateCodePointSafe } from '../../base/util/code-point-cut.js';
import { proseOnly, withoutBold, type ExtractedItem } from './extract.js';
import type { SessionTurn } from './transcript.js';

const MAX_USER_MESSAGE_CHARS = 2000;
/** A reply such as "ok thanks" holds nothing to recall. */
const MIN_USER_MESSAGE_WORDS = 3;

const CUT_MARK = '…';

/** One item per user turn with enough prose, scrubbed and cut, in the order typed; scrubbed after
 * the bold markers go, as capture's own items are. */
export function userMessageItems(
  turns: readonly SessionTurn[],
  scrub: (text: string) => string,
): ExtractedItem[] {
  return turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => scrub(withoutBold(turn.text)).trim())
    .filter(isWorthKeeping)
    .map((text) => ({ content: cut(text), category: USER_MESSAGE_TAG, tags: [USER_MESSAGE_TAG] }));
}

function isWorthKeeping(text: string): boolean {
  return proseOnly(text).split(/\s+/).filter(Boolean).length >= MIN_USER_MESSAGE_WORDS;
}

/** A long message is mostly a paste, so it keeps only the person's own words, then is cut. */
function cut(text: string): string {
  if (text.length <= MAX_USER_MESSAGE_CHARS) return text;
  const prose = proseOnly(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (prose.length <= MAX_USER_MESSAGE_CHARS) return prose;
  const room = MAX_USER_MESSAGE_CHARS - CUT_MARK.length;
  return truncateCodePointSafe(prose, room).trimEnd() + CUT_MARK;
}

/** Where a saved message came from: its session and a hash of its text, since a transcript line
 * has no stable id across a turn close and the full close. */
export function userMessageRef(sessionId: string | undefined, text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, ID_SUFFIX_CHARS);
  return `session:${sessionId ?? 'unknown'}/${hash}`;
}
