import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestMessage } from '../../src/entry/eval-scripts.js';
import { retrieve, adminActor, type Context } from '../../src/entry/eval-scripts.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { RequestStores } from '../../src/db/request-stores.js';
import { loadConfig } from '../../src/host/config-file.js';

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
  session?: RequestStores;
}): Promise<IncidentRecallEvalResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  // SAFETY: scenarios.json is a static, version-controlled fixture checked
  // into this benchmark directory and hand-authored to the Scenario[] shape
  // consumed below (sc.id, sc.transcript) — it is not external/untrusted
  // input.
  const scenarios = JSON.parse(
    readFileSync(join(here, 'scenarios.json'), 'utf-8'),
  ) as Scenario[];
  const ctx: Context = {
    tenantId: 'default',
    actor: adminActor('eval:slack'),
    store: sqliteStore(opts.hippoRoot, { session: opts.session }), config: loadConfig(opts.hippoRoot),
  };
  const results: ScenarioResult[] = [];

  for (const sc of scenarios) {
    const sentinel = (m: { ts: string }): string => `[s:${sc.id}:${m.ts}]`;

    for (const m of sc.transcript) {
      await ingestMessage(ctx, {
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

    const r = await retrieve(ctx, {
      query: sc.query,
      window: { limit: 10 },
      filter: { scope: `slack:public:${sc.channel}` },
    });
    const recallHit = sc.answer_ts.filter((ts) =>
      r.results.some((res) => res.content.includes(sentinel({ ts }))),
    ).length;
    const recallPrecision = recallHit / sc.answer_ts.length;

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
