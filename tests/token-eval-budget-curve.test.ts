/**
 * TE3 token-at-accuracy harness: scoring logic on a hand-built haystack where
 * the evidence is the oldest session, so recency needs the whole budget and
 * relevance does not. Real SQLite, hippo's real search and packer.
 */
import { describe, it, expect } from 'vitest';
import { evaluateQuestion, summarize } from '../scripts/token-eval/budget-curve.mjs';

const filler = (i: number): string =>
  `We talked about the weekend plans, groceries, the gym schedule and a film number ${i}. `.repeat(12);

const QUESTION = {
  question_id: 'q-evidence-oldest',
  question_type: 'single-session-user',
  question: 'Which port does the zanzibar gateway listen on?',
  haystack_session_ids: ['s-evidence', 's1', 's2', 's3', 's4', 's5'],
  haystack_dates: ['2026-01-01', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'],
  haystack_sessions: [
    [{ role: 'user', content: 'The zanzibar gateway listens on port 8443 behind the legacy proxy.' }],
    ...[1, 2, 3, 4, 5].map((i) => [{ role: 'user', content: filler(i) }]),
  ],
  answer_session_ids: ['s-evidence'],
};

describe('budget curve (TE3)', () => {
  it('finds the evidence at a small budget where recency cannot', async () => {
    const budgets = [100, 400, 2000];
    const r = await evaluateQuestion(QUESTION, budgets);
    expect(r.perBudget[100].hippo.hit).toBe(true);
    expect(r.perBudget[100].recency.hit).toBe(false);
    expect(r.perBudget[2000].recency.hit).toBe(true);
    const { hippo: hippoMin, recency: recencyMin } = r.minToAnswer;
    if (!hippoMin || !recencyMin) throw new Error('both arms should answer within the budgets');
    expect(hippoMin.budget).toBe(100);
    expect(recencyMin.budget).toBe(2000);
    expect(r.fullContextHit).toBe(true);
    expect(hippoMin.tokens).toBeLessThan(r.fullContextTokens / 5);

    const s = summarize([r], budgets);
    expect(s.curve[0].hippo.evidenceRecall).toBe(1);
    expect(s.curve[0].recency.evidenceRecall).toBe(0);
    expect(s.minTokensToAnswer.hippo.answered).toBe(1);
  });
});
