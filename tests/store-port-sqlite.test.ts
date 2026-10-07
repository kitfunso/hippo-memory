// Each sqliteStore recall method returns and writes what the hippo.db function behind it does on the golden seed, and a
// recall over serve() opens no more hippo.db handles than today, since every open re-runs the PRAGMAs and migrations.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, getMeta, openHippoDb, setMeta } from '../src/db.js';
import { recordTokens } from '../src/api.js';
import { appendAuditEvent, type AppendAuditOpts } from '../src/audit.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { embeddingIndexIdentity, loadStoredVectors } from '../src/embeddings.js';
import { detectForwardClaim } from '../src/forward-claim-detector.js';
import { boostByGoals, getActiveGoalsWithDb, loadGoalPolicies, localGoalRecallRows, pushGoal, writeGoalRecallLog } from '../src/goals.js';
import { __resetSessionRecallHistoryMcp } from '../src/mcp/server.js';
import { lastRecalledIds } from '../src/mcp/session-state.js';
import { loadPhysicsState, resetAllPhysicsState } from '../src/physics-state.js';
import { resolveClassFromTokens } from '../src/predictions/planning-fallacy.js';
import { computePredictionBaserate } from '../src/predictions/store.js';
import { writeRecallTraceAtRoot } from '../src/recall-trace.js';
import {
  serve, sqliteStore, __resetSessionRecallHistoryHttp,
  type ActiveGoals, type ContinuityKey, type GoalRecallLogRow, type HippoStore, type MemoryEntry, type RecallSearchArgs, type RecallTraceInput, type RecallWrites,
  type VectorCandidateSpec,
} from '../src/server.js';
import { loadEntriesByIds, loadFreshRawMemories } from '../src/store/entry-reads.js';
import { strengthenRetrieved, writeEntry } from '../src/store/entry-writes.js';
import { loadLatestHandoff, saveSessionHandoff } from '../src/store/handoffs.js';
import { updateStats } from '../src/store/index-and-stats.js';
import { loadRecallSearchEntries, loadVectorCandidateEntries } from '../src/store/search-rows.js';
import { appendSessionEvent, listSessionEvents, loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { EMBEDDING_MODEL_META_KEY, hasStoredVectors, upsertVectors } from '../src/vector-store.js';
import { countMatching, recordStatementsAsync, STORE_OPEN } from './_helpers/count-statements.js';
import { hashedVector, startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';
import {
  CLEARED_ENV, FAKE_NOW, freshStore, normalise, rowsOf, seeded, SESSION, seedPortBranches, seedTemplates, statsMirror, TENANT, type Store, type Templates,
} from './_helpers/recall-golden-seed.js';

type Kind = 'local' | 'wide';
interface Outcome<T> { value: T; rows: unknown; opens: number }
/** JSON.stringify throws a TypeError on it, so an audit row carrying it fails mid-write. */
interface Cycle { self?: Cycle }

let templates: Templates;

/** Every audit op in order: rowsOf keeps only the recall ones, and a stray predict_baserate row must show too. */
function auditOps(root: string): unknown[] {
  const db = openHippoDb(root);
  try {
    return db.prepare('SELECT op FROM audit_log ORDER BY id').all();
  } finally {
    closeHippoDb(db);
  }
}

/** Runs `fn` on a fresh copy of a template store: what it returned, every row it left and the handles it opened. */
async function onCopy<T>(kind: Kind, fn: (s: Store) => T | Promise<T>): Promise<Outcome<T>> {
  const s = freshStore(templates, kind);
  try {
    const { result, statements } = await recordStatementsAsync(async () => fn(s));
    const rows = { ...rowsOf(s.root), auditOps: auditOps(s.root), statsMirror: statsMirror(s.root) };
    return normalise({ value: result, rows, opens: countMatching(statements, STORE_OPEN) }, s);
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

/** The direct hippo.db call on one copy and the store method on another must return the same value and leave the same rows. */
async function parity<D, P>(
  direct: (s: Store) => D | Promise<D>,
  port: (store: ReturnType<typeof sqliteStore>) => Promise<P>,
  kind: Kind = 'local',
): Promise<{ direct: Outcome<D>; port: Outcome<P> }> {
  const a = await onCopy(kind, direct);
  const b = await onCopy(kind, (s) => port(sqliteStore(s.root)));
  expect(b.value).toEqual(a.value);
  expect(b.rows).toEqual(a.rows);
  return { direct: a, port: b };
}

function idsOf(entries: readonly MemoryEntry[]): string[] {
  return entries.map((e) => e.id);
}

/** A Map as sorted entries, since normalise's JSON round trip turns a Map into {}. */
function entriesOf<V>(map: ReadonlyMap<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => (a < b ? -1 : 1));
}

const VECTOR_IDENTITY = embeddingIndexIdentity('openai:hashed-16');

/** Vectors and particles for a current, a newer, a private and a superseded row, an 8-dim row, and a vector whose row is gone. */
function seedVectors(root: string): void {
  const entries = loadEntriesByIds(root, ['mem_p_plain', 'mem_p_new', 'mem_p_private', 'mem_p_old', 'mem_p_noise']);
  const index = Object.fromEntries(entries.map((e): [string, number[]] => [e.id, e.id === 'mem_p_noise' ? [1, 0, 0, 0, 0, 0, 0, 0] : hashedVector(e.content)]));
  const db = openHippoDb(root);
  try {
    upsertVectors(db, [...Object.entries(index), ['mem_x_orphan', hashedVector('deploy')]], VECTOR_IDENTITY);
    setMeta(db, EMBEDDING_MODEL_META_KEY, VECTOR_IDENTITY);
    resetAllPhysicsState(db, entries, index, new Date(FAKE_NOW));
  } finally {
    closeHippoDb(db);
  }
}

const TEAM = 'team';
const ALICE_SCOPE = 'personal:private:alice';
const ALICE_A: ContinuityKey = { owner: 'alice', project: ['proj-a'] };

/** A second tenant where alice and bob share proj-a and alice also works in proj-b, so each narrowed read has rows to skip. */
function seedTeam(root: string): void {
  const team = (content: string, id: string, created: string, extra: Partial<MemoryEntry>) => seeded(content, id, created, { tenantId: TEAM, ...extra });
  const rows = [
    team('lighthouse runbook for project a', 'mem_t_a', '2026-01-20T00:00:00.000Z', { origin_project: 'proj-a' }),
    team('lighthouse runbook for project b', 'mem_t_b', '2026-01-20T00:00:00.000Z', { origin_project: 'proj-b' }),
    team('lighthouse notes for every project', 'mem_t_global', '2026-01-20T00:00:00.000Z', { origin_project: '' }),
    team('lighthouse notes alice keeps to herself', 'mem_t_mine', '2026-01-20T00:00:00.000Z', { origin_project: 'proj-a', scope: ALICE_SCOPE }),
    team('lighthouse notes bob keeps to himself', 'mem_t_theirs', '2026-01-20T00:00:00.000Z', { origin_project: 'proj-a', scope: 'personal:private:bob' }),
    team('raw capture in project a', 'mem_t_raw_a', '2026-01-26T00:00:00.000Z', { kind: 'raw', origin_project: 'proj-a' }),
    team('raw capture in project b', 'mem_t_raw_b', '2026-01-27T00:00:00.000Z', { kind: 'raw', origin_project: 'proj-b' }),
    team('raw capture outside any project', 'mem_t_raw_global', '2026-01-28T00:00:00.000Z', { kind: 'raw', origin_project: '' }),
  ];
  for (const row of rows) writeEntry(root, row);
  for (const [owner, project] of [['alice', 'proj-a'], ['bob', 'proj-a'], ['alice', 'proj-b']] as const) {
    const key = { owner, project: [project] };
    const sessionId = `${owner}-${project}`;
    saveActiveTaskSnapshot(root, TEAM, { task: `${owner} ships ${project}`, summary: 'in progress', next_step: 'review', session_id: sessionId }, key);
    saveSessionHandoff(root, TEAM, { version: 1, sessionId, summary: `${owner} hands off ${project}`, nextAction: 'merge' }, key);
    appendSessionEvent(root, TEAM, { session_id: sessionId, event_type: 'note', content: `${owner} noted ${project}` });
  }
  // Newest on alice's session id, so only the key keeps bob's handoff out.
  saveSessionHandoff(root, TEAM, { version: 1, sessionId: 'alice-proj-a', summary: 'bob hands off on her session', nextAction: 'merge' }, { owner: 'bob', project: ['proj-a'] });
}

beforeAll(() => {
  templates = seedTemplates((root) => {
    seedPortBranches(root);
    seedTeam(root);
    // A goal with a retrieval policy, so activeGoals has a policy row to read.
    pushGoal(root, { sessionId: SESSION, tenantId: TENANT, goalName: 'goal-beta', policy: { policyType: 'recency-first', weightRecency: 1.5 } });
    seedVectors(root);
  });
  // The same seed as recall-port-only-parity plus more, which ran past the 30 s hook default on windows-latest CI.
}, 120_000);

afterAll(() => {
  rmSync(templates.dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_V1_RPS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

describe('sqliteStore reads equal the hippo.db functions they wrap and open no more handles', () => {
  const search = (limit: number, extra: Partial<RecallSearchArgs> = {}): RecallSearchArgs => ({
    limit, tenantId: TENANT, explicitScopeMode: 'exact', includeSuperseded: false, ownScope: undefined, ...extra,
  });
  const SEARCHES: readonly [string, string, RecallSearchArgs, Kind, (ids: string[]) => boolean][] = [
    ['the FTS path', 'deploy', search(200), 'local', (ids) => ids.includes('mem_p_plain')],
    ['the LIKE path', 'caf', search(200), 'local', (ids) => ids.includes('mem_x_cafe')],
    ['a query with no terms', '!!', search(200), 'local', (ids) => ids.includes('mem_p_noise')],
    ['scope team-alpha, superseded rows kept', 'deploy', search(200, { requestedScope: 'team-alpha', includeSuperseded: true }), 'local', (ids) => ids.join() === 'mem_p_scoped'],
    ['a 50-row window on the wide store', 'deploy', search(50), 'wide', (ids) => ids.length === 50],
    [
      'one project and its user-global rows, with the caller\'s own personal row',
      'lighthouse',
      search(200, { tenantId: TEAM, originProjects: ['proj-a'], ownScope: ALICE_SCOPE }),
      'local',
      (ids) => [...ids].sort().join() === 'mem_t_a,mem_t_global,mem_t_mine',
    ],
  ];

  it.each(SEARCHES)('searchRecallEntries: %s', async (_name, query, args, kind, reached) => {
    const { direct, port } = await parity(
      (s) => loadRecallSearchEntries(
        s.root, query, args.limit, args.tenantId, args.requestedScope, args.explicitScopeMode, args.includeSuperseded, args.originProjects, args.ownScope,
      ),
      (store) => store.searchRecallEntries(query, args),
      kind,
    );
    expect(reached(idsOf(direct.value))).toBe(true);
    expect(port.opens).toBe(direct.opens);
  });

  it.each([['with a tenant', TENANT], ['without one', undefined]] as const)('entriesByIds %s', async (_name, tenantId) => {
    const ids = ['mem_p_plain', 'mem_x_summary', 'mem_missing'];
    const { direct, port } = await parity((s) => loadEntriesByIds(s.root, ids, tenantId), (store) => store.entriesByIds(ids, tenantId));
    expect(idsOf(direct.value)).toEqual(['mem_x_summary', 'mem_p_plain']);
    expect(port.opens).toBe(direct.opens);
  });

  it.each([['the golden session', SESSION, 2, 1], ['a session with no goals', 'other-session', 0, 0]] as const)(
    'activeGoals: %s',
    async (_name, sessionId, goals, policies) => {
      const opts = { sessionId, tenantId: TENANT };
      const plain = (g: ActiveGoals) => ({ goals: g.goals, policies: [...g.policies] });
      const { direct, port } = await parity((s) => {
        const db = openHippoDb(s.root);
        try {
          const active = getActiveGoalsWithDb(db, opts);
          return plain({ goals: active, policies: loadGoalPolicies(db, active) });
        } finally {
          closeHippoDb(db);
        }
      }, async (store) => plain(await store.activeGoals(opts)));
      expect([direct.value.goals.length, direct.value.policies.length]).toEqual([goals, policies]);
      expect(port.opens).toBe(direct.opens);
    },
  );

  it.each([
    ['a session', 2, TENANT, SESSION, null, ['mem_x_raw']],
    ['the whole tenant', 5, TENANT, undefined, null, ['mem_x_raw']],
    ['a count of 0', 0, TENANT, SESSION, null, []],
    ['one project and its user-global rows', 5, TEAM, undefined, ['proj-a'], ['mem_t_raw_global', 'mem_t_raw_a']],
  ] as const)(
    'freshRawEntries for %s',
    async (_name, count, tenantId, sessionId, origins, ids) => {
      const { direct, port } = await parity(
        (s) => loadFreshRawMemories(s.root, count, tenantId, sessionId, origins ?? undefined),
        (store) => store.freshRawEntries(count, tenantId, sessionId, origins),
      );
      expect(idsOf(direct.value)).toEqual(ids);
      expect(port.opens).toBe(direct.opens);
    },
  );

  it.each([
    ['an active snapshot', TENANT, null, 'local', { activeSnapshot: { session_id: SESSION }, sessionHandoff: { sessionId: SESSION }, recentSessionEvents: [{ content: 'canary passed' }] }],
    ['no active snapshot', TENANT, null, 'wide', { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] }],
    ['a key for one owner and project', TEAM, ALICE_A, 'local', {
      activeSnapshot: { task: 'alice ships proj-a' },
      sessionHandoff: { summary: 'alice hands off proj-a' },
      recentSessionEvents: [{ content: 'alice noted proj-a' }],
    }],
  ] as const)('continuity with %s', async (_name, tenantId, key, kind, block) => {
    // The reads recall made before the port, ahead of its scope filter.
    const { direct, port } = await parity((s) => {
      const activeSnapshot = loadActiveTaskSnapshot(s.root, tenantId, key ?? undefined);
      const sessionId = activeSnapshot?.session_id ?? undefined;
      return {
        activeSnapshot,
        sessionHandoff: sessionId ? loadLatestHandoff(s.root, tenantId, sessionId, {}, key ?? undefined) : null,
        recentSessionEvents: sessionId ? listSessionEvents(s.root, tenantId, { session_id: sessionId, limit: 5 }) : [],
      };
    }, (store) => store.continuity(tenantId, 5, key), kind);
    expect(direct.value).toMatchObject(block);
    expect(port.opens).toBe(direct.opens);
  });

  const claim = detectForwardClaim('the deploy will take 3 days');
  it.each([
    ['a forward claim naming one class', claim?.classQueryTokens ?? [], 'deploy-duration'],
    ['tokens naming no class', ['lunch'], null],
    ['no tokens', [], null],
  ] as const)('planningFallacyEvidence for %s, with no audit row', async (_name, tokens, classTag) => {
    // computePlanningFallacyOutput's reads; its audit rows stay with the caller.
    const { direct, port } = await parity((s) => {
      const resolution = resolveClassFromTokens(s.root, TENANT, tokens);
      const baserate = resolution.classTag ? computePredictionBaserate(s.root, TENANT, resolution.classTag, 'recall', false) : null;
      return { ...resolution, baserate };
    }, (store) => store.planningFallacyEvidence(TENANT, tokens));
    expect(direct.value).toMatchObject({ classTag, tiebreak: false, baserate: classTag ? { nClosed: 1 } : null });
    expect(port.opens).toBe(direct.opens);
  });

  it.each([
    ['vectors under a stored model', 'local', { storedModel: VECTOR_IDENTITY, hasVectors: true }],
    ['no vectors', 'wide', { storedModel: null, hasVectors: false }],
  ] as const)('embeddingIndexState with %s: the meta row and the EXISTS on one handle', async (_name, kind, state) => {
    // Before the port the vector arm read these on two handles.
    const { direct, port } = await parity((s) => {
      const db = openHippoDb(s.root);
      try {
        return { storedModel: getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim() || null, hasVectors: hasStoredVectors(db) };
      } finally {
        closeHippoDb(db);
      }
    }, (store) => store.vectors.embeddingIndexState(), kind);
    expect(direct.value).toEqual(state);
    expect([direct.opens, port.opens]).toEqual([1, 1]);
  });

  it('storedVectors returns what loadStoredVectors does, an 8-dim row and a vector without a row included', async () => {
    const ids = ['mem_p_plain', 'mem_p_noise', 'mem_x_orphan', 'mem_missing'];
    const { direct, port } = await parity((s) => entriesOf(loadStoredVectors(s.root, ids)), async (store) => entriesOf(await store.vectors.storedVectors(ids)));
    expect(direct.value.map(([id, v]) => [id, v.length])).toEqual([['mem_p_noise', 8], ['mem_p_plain', 16], ['mem_x_orphan', 16]]);
    expect(port.opens).toBe(direct.opens);
  });

  const nearTo = hashedVector('deploy pipeline uses blue green rollout for the api');
  const NEAREST: readonly [string, VectorCandidateSpec, readonly string[]][] = [
    ['current rows in the default scopes', { tenantId: TENANT, scope: { mode: 'default-deny' }, includeSuperseded: false }, ['mem_p_new', 'mem_p_plain']],
    ['superseded rows kept, no scope rule', { tenantId: TENANT, includeSuperseded: true }, ['mem_p_new', 'mem_p_old', 'mem_p_plain', 'mem_p_private']],
    ['a private scope asked for exactly', { tenantId: TENANT, scope: { mode: 'exact', value: 'slack:private:C1' }, includeSuperseded: false }, ['mem_p_private']],
    ['another tenant', { tenantId: 'other', includeSuperseded: true }, []],
    ['a cut at 1', { includeSuperseded: false, limit: 1 }, ['mem_p_plain']],
  ];

  it.each(NEAREST)('nearestEntries: %s', async (_name, spec, ids) => {
    const { direct, port } = await parity((s) => loadVectorCandidateEntries(s.root, nearTo, spec), (store) => store.vectors.nearestEntries(nearTo, spec));
    expect([...idsOf(direct.value)].sort()).toEqual(ids);
    expect(port.opens).toBe(direct.opens);
  });

  it('physicsParticles reads only the ids asked for, as loadPhysicsState does, and opens nothing for none', async () => {
    const ids = ['mem_p_plain', 'mem_p_noise', 'mem_x_orphan', 'mem_missing'];
    const { direct, port } = await parity((s) => {
      const db = openHippoDb(s.root);
      try {
        return entriesOf(loadPhysicsState(db, ids));
      } finally {
        closeHippoDb(db);
      }
    }, async (store) => entriesOf(await store.vectors.physicsParticles(ids)));
    expect(direct.value.map(([id]) => id)).toEqual(['mem_p_noise', 'mem_p_plain']);
    expect(port.opens).toBe(direct.opens);
    const none = await onCopy('local', async (s) => (await sqliteStore(s.root).vectors.physicsParticles([])).size);
    expect([none.value, none.opens]).toEqual([0, 0]);
  });
});

describe('sqliteStore writes leave the rows the hippo.db functions leave, each on one handle', () => {
  const recallAudit = (op: AppendAuditOpts['op'], metadata: AppendAuditOpts['metadata']): AppendAuditOpts => ({ tenantId: TENANT, actor: 'api_key:hk_test', op, metadata });
  const events: readonly AppendAuditOpts[] = [
    recallAudit('recall', { query_length: 6, results: 3 }),
    recallAudit('recall_availability_detected', { recent_fraction: 1, older_passed_over: 2, returned_count: 3 }),
  ];

  it('appendAuditEvents writes the rows in order on one handle, where each recall audit opened its own before the port', async () => {
    const { direct, port } = await parity((s) => {
      for (const event of events) {
        const db = openHippoDb(s.root);
        try {
          appendAuditEvent(db, event);
        } finally {
          closeHippoDb(db);
        }
      }
    }, (store) => store.appendAuditEvents(events));
    expect(direct.opens).toBe(2);
    expect(port.opens).toBe(1);
  });

  it('appendAuditEvents writes none of the rows when one fails, and opens nothing for an empty list', async () => {
    const loop: Cycle = {};
    loop.self = loop;
    const s = freshStore(templates, 'local');
    try {
      const before = auditOps(s.root);
      await expect(sqliteStore(s.root).appendAuditEvents([events[0]!, recallAudit('recall', loop)])).rejects.toThrow(TypeError);
      expect(auditOps(s.root)).toEqual(before);
      const { statements } = await recordStatementsAsync(() => sqliteStore(s.root).appendAuditEvents([]));
      expect(countMatching(statements, STORE_OPEN)).toBe(0);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  const trace: RecallTraceInput = {
    tenantId: TENANT,
    sessionId: SESSION,
    pipeline: 'api',
    query: 'deploy',
    explainMode: true,
    results: [
      { memoryId: 'mem_p_goal', score: 1.6, rerankSteps: [{ stage: 'goal-boost', multiplier: 2, scoreBefore: 0.8, scoreAfter: 1.6 }] },
      { memoryId: 'mem_p_plain', score: 0.9 },
    ],
  };
  const strengthen = { ids: ['mem_p_plain', 'mem_p_new', 'mem_missing'], opts: { tenantId: TENANT, recallBoostAblated: false } };
  const logRow = (memoryId: string, score: number): GoalRecallLogRow => ({
    goalId: templates.goalId, memoryId, tenantId: TENANT, sessionId: SESSION, recalledAt: FAKE_NOW, score,
  });
  const finishWrites = (): RecallWrites => ({ goalLog: [logRow('mem_p_goal', 1.6), logRow('mem_p_global', 1.4)], audit: events, trace, strengthen });

  it('finishRecall writes what the goal boost, the audit, the trace and the strengthen wrote, on one handle', async () => {
    const globalRow = seeded('deploy notes from the global store about rollbacks', 'mem_p_global', '2026-01-12T00:00:00.000Z', {}, { tags: ['goal-alpha'] });
    const { direct, port } = await parity((s) => {
      const [goalRow] = loadEntriesByIds(s.root, ['mem_p_goal']);
      const db = openHippoDb(s.root);
      try {
        const goals = getActiveGoalsWithDb(db, { sessionId: SESSION, tenantId: TENANT });
        const boost = boostByGoals(
          [{ entry: goalRow!, score: 0.8 }, { entry: globalRow, score: 0.7 }],
          { goals, policies: loadGoalPolicies(db, goals) },
          { sessionId: SESSION, tenantId: TENANT, limit: 10 },
        );
        writeGoalRecallLog(db, localGoalRecallRows(db, boost.log));
        for (const event of events) appendAuditEvent(db, event);
      } finally {
        closeHippoDb(db);
      }
      writeRecallTraceAtRoot(s.root, trace);
      strengthenRetrieved(s.root, strengthen.ids, strengthen.opts);
    }, (store) => store.finishRecall(finishWrites()));
    // The global row's memory lives in another store, so its log row is dropped.
    expect(direct.rows).toMatchObject({ goalRecallLog: [{ memory_id: 'mem_p_goal', score: 1.6 }] });
    expect(port.opens).toBe(1);
  });

  it('finishRecall writes no goal log or audit row when one audit row fails', async () => {
    const loop: Cycle = {};
    loop.self = loop;
    const s = freshStore(templates, 'local');
    try {
      const before = rowsOf(s.root);
      await expect(sqliteStore(s.root).finishRecall({ ...finishWrites(), audit: [events[0]!, recallAudit('recall', loop)] })).rejects.toThrow(TypeError);
      expect(rowsOf(s.root)).toEqual(before);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  it('finishRecall keeps the first log row for a memory and goal, within one batch and across recalls', async () => {
    const s = freshStore(templates, 'local');
    try {
      const store = sqliteStore(s.root);
      const kept = [{ goal_id: templates.goalId, memory_id: 'mem_p_goal', session_id: SESSION, score: 1.6 }];
      await store.finishRecall({ goalLog: [logRow('mem_p_goal', 1.6), logRow('mem_p_goal', 0.4)], audit: [] });
      expect(rowsOf(s.root).goalRecallLog).toEqual(kept);
      await store.finishRecall({ goalLog: [logRow('mem_p_goal', 2.2)], audit: [] });
      expect(rowsOf(s.root).goalRecallLog).toEqual(kept);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  it('bumpRecallStats adds to the recall counter and rewrites stats.json, as updateStats does', async () => {
    const { direct, port } = await parity((s) => updateStats(s.root, { recalled: 3 }), (store) => store.bumpRecallStats(3));
    expect(direct.rows).toMatchObject({
      stats: expect.arrayContaining([{ key: 'total_recalled', value: '3' }]),
      statsMirror: expect.stringContaining('"total_recalled": 3'),
    });
    expect(port.opens).toBe(1);
  });

  it('recordTokens writes the ledger row the API helper writes', async () => {
    const { port } = await parity(
      (s) => recordTokens({ hippoRoot: s.root, tenantId: TENANT, actor: { subject: 'test', role: 'admin' } }, 'http_recall', { items: 2, tokens: 40, sessionId: SESSION }),
      (store) => store.recordTokens({ tenantId: TENANT, sessionId: SESSION, surface: 'http_recall', event: 'inject', items: 2, tokens: 40 }),
    );
    expect(port.rows).toMatchObject({ ledger: [{ surface: 'http_recall', items: 2, tokens: 40 }] });
    expect(port.opens).toBe(1);
  });

  it('recordTokens throws where the API helper logs and returns, so the caller decides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-store-port-'));
    try {
      mkdirSync(join(root, 'hippo.db'));
      const use = { tenantId: TENANT, surface: 'http_recall', event: 'inject', items: 1, tokens: 1 } as const;
      await expect(sqliteStore(root).recordTokens(use)).rejects.toThrow();
      await expect(recordTokens({ hippoRoot: root, tenantId: TENANT, actor: { subject: 'test', role: 'admin' } }, 'http_recall', use)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

type Recall = { via: 'http'; params: Record<string, string> } | { via: 'mcp'; args: Record<string, string> };

async function recallOver(url: string, call: Recall): Promise<void> {
  if (call.via === 'http') {
    const res = await fetch(`${url}/v1/memories?${new URLSearchParams(call.params).toString()}`);
    expect(res.status).toBe(200);
    await res.json();
    return;
  }
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: call.args } };
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
  expect(await res.json()).not.toHaveProperty('error');
}

describe('hippo.db opens per recall over serve()', () => {
  // Exact, so a second open fails here: the request scope hands every port call the one handle.
  const OPENS: readonly [string, number, Recall, boolean?][] = [
    ['http, no session', 1, { via: 'http', params: { q: 'deploy' } }],
    ['http, a session with active goals', 1, { via: 'http', params: { q: 'deploy', session_id: SESSION } }],
    ['http, continuity and a forward claim', 1, { via: 'http', params: { q: 'the deploy will take 3 days', include_continuity: 'true' } }],
    ['mcp, no session', 1, { via: 'mcp', args: { query: 'deploy' } }],
    ['mcp, a session with active goals', 1, { via: 'mcp', args: { query: 'deploy', session_id: SESSION } }],
    ['http hybrid, the vector arm on', 1, { via: 'http', params: { q: 'deploy', mode: 'hybrid' } }, true],
    ['http physics, the vector arm on', 1, { via: 'http', params: { q: 'deploy', mode: 'physics' } }, true],
  ];
  let embeddings: HashedEmbeddings;

  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
  });

  afterAll(async () => {
    await embeddings.close();
  });

  beforeEach(() => {
    __resetSessionRecallHistoryHttp();
    __resetSessionRecallHistoryMcp();
    lastRecalledIds.clear();
  });

  it.each(OPENS)('%s: %i opens', async (_name, opens, call, vectorArm = false) => {
    const s = freshStore(templates, 'local');
    try {
      if (vectorArm) {
        vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
        const embeddingsConfig = { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url };
        writeFileSync(join(s.root, 'config.json'), JSON.stringify({ embeddings: embeddingsConfig, physics: { enabled: true } }));
      }
      const before = embeddings.requests();
      const handle = await serve({ hippoRoot: s.root, port: 0 });
      try {
        const { statements } = await recordStatementsAsync(() => recallOver(handle.url, call));
        expect(countMatching(statements, STORE_OPEN)).toBe(opens);
        expect(embeddings.requests() > before).toBe(vectorArm);
      } finally {
        await handle.stop();
      }
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a recall whose store read fails mid-way', () => {
  beforeEach(() => {
    __resetSessionRecallHistoryHttp();
    __resetSessionRecallHistoryMcp();
    lastRecalledIds.clear();
  });

  // Continuity is read after the search, the goals and the fresh tail, so the earlier reads have run.
  it.each([
    ['http', `/v1/memories?q=deploy&session_id=${SESSION}&include_continuity=true`],
    ['mcp', '/mcp'],
  ] as const)('%s writes no row and no stats', async (via, path) => {
    const s = freshStore(templates, 'local');
    try {
      let reads = 0;
      const store: HippoStore = {
        ...sqliteStore(s.root),
        continuity: () => {
          reads += 1;
          return Promise.reject(new Error('continuity read failed'));
        },
      };
      const before = { ...rowsOf(s.root), auditOps: auditOps(s.root), statsMirror: statsMirror(s.root) };
      const handle = await serve({ hippoRoot: s.root, port: 0, store });
      try {
        const args = { query: 'deploy', session_id: SESSION, include_continuity: true };
        const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: args } };
        const res = via === 'http'
          ? await fetch(`${handle.url}${path}`)
          : await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
        const body: unknown = await res.json();
        if (via === 'http') expect(res.status).toBe(500);
        else expect(body).toMatchObject({ error: { code: -32603, message: expect.stringMatching(/^internal server error/) } });
      } finally {
        await handle.stop();
      }
      expect(reads).toBe(1);
      expect({ ...rowsOf(s.root), auditOps: auditOps(s.root), statsMirror: statsMirror(s.root) }).toEqual(before);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  }, 60_000);
});
