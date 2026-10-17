// What each recall path of retrieve() returns and writes over one fixed store: the ids in order, the audit rows, the
// strengthened ids, the trace and last_retrieval_ids, pinned so folding the paths into one ranker cannot move any of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { adminActor, type RecallResult } from '../../src/api/index.js';
import { retrieve } from '../../src/api/recall/recall.js';
import { RECALL_RECORDING } from '../../src/api/recall/finish.js';
import type { CliCoreRecall } from '../../src/api/recall/types.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { loadConfig } from '../../src/core/config.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/audit.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { isJsonNumber } from '../../src/util/json.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { CLEARED_ENV, FAKE_NOW, pinUpdatedAt, seeded, TENANT } from '../_helpers/recall-golden-seed.js';
import { loadEntriesByIds, loadLastRecall } from '../_helpers/root-forms.js';
import type { AppendAuditOpts, AuditEvent } from '../../src/store/port/types.js';

const ROWS = [
  seeded('deploy pipeline uses blue green rollout', 'mem_o_a', '2026-01-28T00:00:00.000Z'),
  seeded('deploy freeze on fridays for billing', 'mem_o_b', '2026-01-10T00:00:00.000Z'),
  seeded('deploy token rotates weekly; deploy keys live in vault', 'mem_o_c', '2026-01-20T00:00:00.000Z'),
  seeded('deploy target is the eu west cluster', 'mem_o_d', '2026-01-05T00:00:00.000Z', { strength: 0.4 }),
  seeded('rollback plan for a failed deploy', 'mem_o_e', '2026-01-30T00:00:00.000Z'),
  seeded('lunch menu on thursdays', 'mem_o_f', '2026-01-29T00:00:00.000Z'),
];

// A forward claim with no prediction class, so every path writes its planning row too.
const CLAIM = 'the deploy will take 3 days';

// A hint row of the caller's own, so the test sees where each path puts it among the recall's rows.
const CALLER_ROW: AppendAuditOpts = { tenantId: TENANT, actor: 'order-test', op: 'recall_availability_detected' };

interface Written {
  readonly audit: readonly (readonly [string, number | null])[];
  readonly strengthened: readonly string[];
  readonly traces: readonly (readonly [string, number])[];
  readonly lastRetrievalIds: readonly string[];
}

let root: string;
// Seeding writes 'remember' rows; only the rows after it are the recall's.
let seededAuditId: number;

function ctx(): FullContext {
  return apiCtx(root, TENANT, adminActor('order-test'));
}

function cliCore(): Pick<CliCoreRecall, 'rank'> {
  const config = loadConfig(root);
  return {
    rank: {
      budget: 4000, cost: (r) => r.tokens, window: { limit: 3 }, includeSuperseded: false, explicitScope: null, activeScope: null,
      search: { usePhysics: false, physicsConfig: config.physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain: false },
    },
  };
}

// Opened here: the store-worker helper also starts servers, so importing it would class this file as a process test.
function onDb<T>(root: string, use: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return use(db);
  } finally {
    closeHippoDb(db);
  }
}

function auditRows(): AuditEvent[] {
  return onDb(root, (db) => queryAuditEvents(db, { tenantId: TENANT })).reverse();
}

function written(): Written {
  const audit = auditRows()
    .filter((e) => e.id > seededAuditId)
    .map((e) => [e.op, isJsonNumber(e.metadata.results) ? e.metadata.results : null] as const);
  const strengthened = loadEntriesByIds(root, ROWS.map((r) => r.id), TENANT)
    .filter((e) => (e.retrieval_count ?? 0) > 0)
    .map((e) => e.id)
    .sort();
  const traces = onDb(root, (db) =>
    db.prepare('SELECT pipeline, result_count FROM recall_traces ORDER BY id').all().map((r) => {
      // SAFETY: the SELECT names two NOT NULL recall_traces columns, a TEXT and an INTEGER.
      const row = r as { pipeline: string; result_count: number };
      return [row.pipeline, Number(row.result_count)] as const;
    }),
  );
  return { audit, strengthened, traces, lastRetrievalIds: loadLastRecall(root).last_retrieval_ids };
}

const idsOf = (result: RecallResult): string[] => result.results.map((r) => r.id);

beforeEach(() => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  _resetAblationCacheForTests();
  root = makeRoot('recall-paths-order');
  vi.stubEnv('HIPPO_HOME', join(root, 'global-home'));
  for (const row of ROWS) writeEntry(root, row);
  pinUpdatedAt(root);
  seededAuditId = Math.max(0, ...auditRows().map((e) => e.id));
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('retrieve paths: order and writes', () => {
  it('the band ranker returns its band, audits and strengthens it, and leaves last_retrieval_ids alone', async () => {
    const result = await retrieve(ctx(), { query: CLAIM, window: { limit: 3 } });
    expect(idsOf(result)).toEqual(BAND_IDS);
    expect(written()).toEqual({
      audit: [['recall', 3], ['recall_autodebias_hint_no_class_match', null]],
      strengthened: [...BAND_IDS].sort(),
      traces: [['api', 3]],
      lastRetrievalIds: [],
    });
  });

  it('the band ranker recorded for HTTP writes the no-session row first', async () => {
    const result = await retrieve(ctx(), { query: CLAIM, window: { limit: 3 }, trace: { recordAs: RECALL_RECORDING.http } });
    expect(idsOf(result)).toEqual(BAND_IDS);
    expect(written()).toEqual({
      audit: [['recall_anchor_skipped_no_session', null], ['recall', 3], ['recall_autodebias_hint_no_class_match', null]],
      strengthened: [...BAND_IDS].sort(),
      traces: [['api', 3]],
      lastRetrievalIds: [],
    });
  });

  it('showRanked returns the band, audits the shown list after it, and strengthens only the shown ids', async () => {
    let ranked: string[] = [];
    const result = await retrieve(ctx(), {
      query: CLAIM,
      window: { limit: 3 },
      filter: { keepHeldCopies: true },
      hints: { suppressAvailabilityHint: true },
      showRanked: (ranking) => {
        ranked = ranking.ranked.map((r) => r.entry.id);
        return { ids: ranked.slice(0, 2), audit: [CALLER_ROW] };
      },
    });
    expect(ranked).toEqual(WIDE_RANKED);
    expect(idsOf(result)).toEqual(WIDE_BAND_IDS);
    expect(written()).toEqual({
      audit: [['recall_autodebias_hint_no_class_match', null], ['recall', 2], ['recall_availability_detected', null]],
      strengthened: WIDE_RANKED.slice(0, 2).sort(),
      traces: [['mcp', 2]],
      lastRetrievalIds: [],
    });
  });

  it('the CLI core returns what it showed, audits the caller rows before the recall, and marks the last recall', async () => {
    const result = await retrieve(ctx(), {
      query: CLAIM,
      cliCore: { ...cliCore(), show: (ranking) => ({ results: ranking.results.slice(0, 2), audit: [CALLER_ROW], tokens: 7 }) },
    });
    expect(idsOf(result)).toEqual(CORE_IDS);
    expect(written()).toEqual({
      audit: [['recall_autodebias_hint_no_class_match', null], ['recall_availability_detected', null], ['recall', 2]],
      strengthened: [...CORE_IDS].sort(),
      traces: [['cli', 2]],
      lastRetrievalIds: CORE_IDS,
    });
  });

  it('the CLI core under inspect returns the ranking and writes nothing', async () => {
    let inspected: string[] = [];
    const result = await retrieve(ctx(), {
      query: CLAIM,
      cliCore: { ...cliCore(), inspect: (ranking) => { inspected = ranking.results.map((r) => r.entry.id); } },
    });
    expect(inspected).toEqual(INSPECT_IDS);
    expect(idsOf(result)).toEqual(INSPECT_IDS);
    expect(written()).toEqual({ audit: [], strengthened: [], traces: [], lastRetrievalIds: [] });
  });
});

const BAND_IDS = ['mem_o_d', 'mem_o_c', 'mem_o_b'];
const WIDE_RANKED = ['mem_o_d', 'mem_o_c', 'mem_o_e', 'mem_o_a', 'mem_o_b'];
const WIDE_BAND_IDS = ['mem_o_d', 'mem_o_c', 'mem_o_e'];
const CORE_IDS = ['mem_o_d', 'mem_o_c'];
const INSPECT_IDS = ['mem_o_d', 'mem_o_c', 'mem_o_e'];
