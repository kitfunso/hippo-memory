// The per-prompt hook prints each section and memory once per host context window. The ledger's marks say what the
// window holds; keys carry a content hash, so an edited memory or section prints again at once.
import type { MemoryEntry } from '../core/memory.js';
import type { SendWindow } from '../store/token-ledger.js';
import { blockHash } from '../util/token-text.js';

/** Turns after which any mark lapses and its text prints again, so a missed reset cannot hide a memory for long. */
export const MARK_LIFE = 25;

// pinnedInject.refreshTurns when the config gives no usable number.
const DEFAULT_REFRESH_TURNS = 10;

/** What one call filters against: the session's window and the pinned refresh. */
export interface SendRule {
  readonly window: SendWindow;
  /** Pinned memories print again this many turns after their last send; 0 leaves them to MARK_LIFE. */
  readonly refreshTurns: number;
}

export const EMPTY_WINDOW: SendWindow = Object.freeze({ turn: 0, sent: new Map() });

export function refreshTurnsOf(configured: number): number {
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_REFRESH_TURNS;
}

export function memoryKey(entry: Pick<MemoryEntry, 'id' | 'content'>, owner: string | undefined): string {
  return ownedKey(`mem:${entry.id}:${blockHash(entry.content)}`, owner);
}

/** A snapshot, handoff or trail section, keyed on its printed text. */
export function sectionKey(kind: 'snapshot' | 'handoff' | 'trail', text: string, owner: string | undefined): string {
  return ownedKey(`${kind}:${blockHash(text)}`, owner);
}

// The owner suffix keeps one person's marks from hiding text from another who reuses the session id.
function ownedKey(key: string, owner: string | undefined): string {
  return owner === undefined ? key : `${key}@${owner}`;
}

/** True when `key` was never printed in the window, or its mark has lapsed. */
export function isFresh(rule: SendRule, key: string, pinned: boolean): boolean {
  const mark = rule.window.sent.get(key);
  if (mark === undefined) return true;
  const life = pinned && rule.refreshTurns > 0 ? rule.refreshTurns : MARK_LIFE;
  return rule.window.turn - mark.turn >= life;
}
