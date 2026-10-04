/**
 * TE4 session replay harness as a CI gate: replays a short session through
 * the real per-prompt hook in both arms and checks what hippo injects.
 * No LLM calls, real CLI, real SQLite.
 */
import { describe, it, expect } from 'vitest';
import { replayTrace, replayAll } from '../scripts/token-eval/replay.mjs';

const TRACE = {
  name: 'ci-short',
  description: 'six prompts, one lesson, one compaction',
  synthetic: true,
  pinned: ['NEVER force-push to master; it rewrites shared history'],
  events: [
    { type: 'prompt' },
    { type: 'prompt' },
    { type: 'remember', text: 'The staging deploy needs VPN or the health check times out' },
    { type: 'prompt' },
    { type: 'prompt' },
    { type: 'compact' },
    { type: 'prompt' },
    { type: 'prompt' },
  ],
};

describe('session replay (TE4)', () => {
  it('every-turn injects on every prompt with byte-identical unchanged blocks', () => {
    const r = replayTrace(TRACE, 'every-turn');
    expect(r.prompts).toBe(6);
    expect(r.injections).toBe(6);
    expect(r.identicalWhenUnchanged).toBe(1);
  });

  it('skip-unchanged injects only on the first prompt, after a change and after compaction', () => {
    const r = replayTrace(TRACE, 'skip-unchanged');
    expect(r.perPrompt.map((k: number) => k > 0)).toEqual([true, false, true, false, true, false]);
  });

  it('reports a lower cache-priced cost for skip-unchanged', () => {
    const { byTrace } = replayAll([TRACE]);
    const row = byTrace[0]!;
    expect(row.skipUnchanged.injectedTokens).toBeLessThan(row.everyTurn.injectedTokens);
    expect(row.costReduction).toBeGreaterThan(0.3);
  });
});
