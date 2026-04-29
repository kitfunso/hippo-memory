/**
 * E1.3 incident-recall eval (Task 17).
 *
 * ROADMAP success criterion: recall surfaces incident context faster than
 * transcript replay on at least 7 of 10 staged scenarios.
 *
 * Approach (review patch #8): stamp a per-message sentinel
 * `[s:<scenario.id>:<m.ts>]` into the ingested text. Sentinels are unique
 * across the corpus, so checking sentinel substring presence in
 * `RecallResultItem.content` is a deterministic equality test — no false
 * positives from ambient phrase repetition, no need to extend the recall
 * response shape with artifact_ref.
 *
 * Baseline: take the last 10 messages of the raw transcript (the
 * "transcript replay" a human would do by scrolling to the bottom). Answers
 * are buried mid-transcript so the baseline misses them. Recall must beat
 * that on >=7/10 scenarios.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ingestMessage } from '../../src/connectors/slack/ingest.js';
import { recall, type Context } from '../../src/api.js';

interface TranscriptMessage {
  user: string;
  text: string;
  ts: string;
}

interface Scenario {
  id: string;
  channel: string;
  transcript: TranscriptMessage[];
  query: string;
  answer_ts: string[];
}

export interface ScenarioResult {
  id: string;
  recallPrecision: number;
  baselinePrecision: number;
  beat: boolean;
}

export interface IncidentRecallEvalResult {
  scenarios: ScenarioResult[];
  scenariosBeaten: number;
}

export async function runIncidentRecallEval(opts: {
  hippoRoot: string;
}): Promise<IncidentRecallEvalResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const scenarios = JSON.parse(
    readFileSync(join(here, 'scenarios.json'), 'utf-8'),
  ) as Scenario[];
  const ctx: Context = {
    hippoRoot: opts.hippoRoot,
    tenantId: 'default',
    actor: 'eval:slack',
  };
  const results: ScenarioResult[] = [];

  for (const sc of scenarios) {
    const sentinel = (m: { ts: string }): string => `[s:${sc.id}:${m.ts}]`;

    for (const m of sc.transcript) {
      ingestMessage(ctx, {
        teamId: 'T1',
        channel: { id: sc.channel, is_private: false },
        message: {
          type: 'message',
          channel: sc.channel,
          user: m.user,
          text: `${m.text} ${sentinel(m)}`,
          ts: m.ts,
        },
        eventId: `${sc.id}:${m.ts}`,
      });
    }

    const r = recall(ctx, {
      query: sc.query,
      limit: 10,
      scope: `slack:public:${sc.channel}`,
    });
    const recallHit = sc.answer_ts.filter((ts) =>
      r.results.some((res) => res.content.includes(sentinel({ ts }))),
    ).length;
    const recallPrecision = recallHit / sc.answer_ts.length;

    // Baseline: linear transcript scan returning the last 10 messages — what a
    // human does when they scroll to the bottom of a Slack channel. Direct
    // ts equality is enough; sentinels are not in the raw transcript.
    const tail = sc.transcript.slice(-10);
    const baselineHit = sc.answer_ts.filter((ts) =>
      tail.some((m) => m.ts === ts),
    ).length;
    const baselinePrecision = baselineHit / sc.answer_ts.length;

    results.push({
      id: sc.id,
      recallPrecision,
      baselinePrecision,
      beat: recallPrecision > baselinePrecision,
    });
  }

  return {
    scenarios: results,
    scenariosBeaten: results.filter((r) => r.beat).length,
  };
}
