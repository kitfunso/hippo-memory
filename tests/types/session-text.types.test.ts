/** The types an integrator sees from `hippo-memory/session-text` (src/entry/session-text.ts). */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  COMPACTION_ITEM_MAX_CHARS, COMPACTION_ITEM_ROW_CAP, collectSessionTurns, compactSummaryBody, parseCompactionItems,
  scrubForSharing, sessionTail, type SessionTurn,
} from '../../src/entry/session-text.js';

describe('hippo-memory/session-text entry types', () => {
  it('SessionTurn is a role and a text', () => {
    expectTypeOf<SessionTurn>().toEqualTypeOf<{ role: 'user' | 'assistant'; text: string }>();
  });

  it('collectSessionTurns reads a transcript string and returns turns', () => {
    expectTypeOf(collectSessionTurns).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(collectSessionTurns).returns.toEqualTypeOf<SessionTurn[]>();
    // @ts-expect-error the transcript is the JSONL text, not a turn list
    typeOnly(() => collectSessionTurns([]));
  });

  it('sessionTail takes turns and returns user and assistant text lists', () => {
    expectTypeOf(sessionTail).parameters.toEqualTypeOf<[readonly SessionTurn[]]>();
    expectTypeOf(sessionTail).returns.toMatchTypeOf<{ users: string[]; assistants: string[] }>();
  });

  it('scrubForSharing maps text to text', () => {
    expectTypeOf(scrubForSharing).toEqualTypeOf<(text: string) => string>();
    // @ts-expect-error text only
    typeOnly(() => scrubForSharing(null));
  });

  it('compaction helpers take the summary text', () => {
    expectTypeOf(compactSummaryBody).toEqualTypeOf<(compactSummary: string) => string>();
    expectTypeOf(parseCompactionItems).parameters.toEqualTypeOf<[summaryBody: string]>();
    expectTypeOf(parseCompactionItems).returns.toEqualTypeOf<{ found: boolean; items: string[] }>();
  });

  it('the caps keep their literal types', () => {
    expectTypeOf<typeof COMPACTION_ITEM_MAX_CHARS>().toEqualTypeOf<500>();
    expectTypeOf<typeof COMPACTION_ITEM_ROW_CAP>().toEqualTypeOf<10>();
    expect(scrubForSharing('plain text')).toBe('plain text');
  });
});
