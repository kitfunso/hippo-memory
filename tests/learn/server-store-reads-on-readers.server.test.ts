// Each store method the op table places on a reader thread answers as the in-process store does and never waits for the write lock; each write this file names leaves what the in-process one leaves.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { detectForwardClaim } from '../../src/domain/learn/forward-claim-detector.js';
import { SKILL } from '../../src/domain/objects/skills.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { packVectors, vectorViewsOf } from '../../src/store/sqlite/runtime/vector-pack.js';
import { HIPPO_DB_OPS, WORKER_OPS } from '../../src/store/sqlite/runtime/worker-ops.js';
import { workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import { hashedVector } from '../_helpers/hashed-embedding-server.js';
import { leftBehind, type MovedReadsSeed, seedMovedReads, VECTOR_IDENTITY } from '../_helpers/moved-reads-seed.js';
import { FAKE_NOW, freshStore, SESSION, TENANT } from '../_helpers/recall-golden-seed.js';
import { cleanups, holdWriteLock, mirrorFiles, onDb, patientStore, undoAll } from '../_helpers/store-worker-server.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant/dormant-rows.js';
import { rejectValue } from '../../src/domain/trust/reject-flow.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { cliSave } from '../_helpers/cli-save-site.js';
import {
  type Call,
  LOCAL_GROUP_READS,
  PLAIN,
  read,
  type Read,
  REFUSED,
  seedLocalGroups,
  shown,
} from '../_helpers/local-group-reads.js';
import type { HippoDbStore } from '../../src/store/sqlite/hippo-db.js';
import { waitFor } from '../_helpers/wait-for.js';

const NOW = new Date(FAKE_NOW);
const VECTOR_IDS = ['mem_p_plain', 'mem_p_noise', 'mem_x_orphan', 'mem_missing'];

const graphEntities = async (s: HippoDbStore) => (await s.graphReads.graphRows(TENANT, { limit: 50 })).entities;

const SLACK_EVENT = { connector: 'slack', eventId: 'Ev-seeded' } as const;
const REPO = 'acme/demo';
const SLACK_CURSOR = {
  connector: 'slack',
  tenantId: TENANT,
  channelId: 'C-seeded',
} as const;
const GITHUB_CURSOR = {
  connector: 'github',
  tenantId: TENANT,
  repo: REPO,
  stream: 'issues',
} as const;
/** Ids the extra seed makes, read by the rows below once it has run. */
const made = { handoffId: 0, cardId: '' };

/** The rows the moved-reads seed lacks, written through the in-process store: connector state, working memory, a claimed card, a failure, a token row, a rejection, a conflict and a dormant memory. */
async function seedSessionAndAdmin(root: string): Promise<void> {
  const s = sqliteStore(root);
  await s.hippoDb.connectorEvents.markEventSeen(SLACK_EVENT);
  await s.hippoDb.connectorEvents.registerSlackWorkspace('T-seeded', TENANT);
  await s.hippoDb.connectorEvents.parkDeadLetter({
    connector: 'github',
    tenantId: TENANT,
    rawPayload: '{"seeded":true}',
    error: 'unroutable payload',
    signature: null,
    bucket: 'unroutable',
  });
  await s.hippoDb.connectorEvents.saveCursor(SLACK_CURSOR, '1700000000.000100');
  await s.hippoDb.connectorEvents.saveCursor(GITHUB_CURSOR, '2026-01-01T00:00:00Z');
  await s.hippoDb.sessions.save(TENANT, 'working_memory', {
    scope: 'deploy',
    content: 'watch the canary error rate',
    sessionId: SESSION,
  });
  const card = await s.cards.create(TENANT, { title: 'cut the eu release' });
  await s.cards.claim(TENANT, card.id, 'codex', SESSION);
  await s.failureLog.record({
    tenantId: TENANT,
    sessionId: SESSION,
    tool: 'Bash',
    outcome: 'stored',
    requestId: 'req-seeded',
    now: FAKE_NOW,
  });
  await s.recordTokens({
    tenantId: TENANT,
    sessionId: SESSION,
    surface: 'http_recall',
    event: 'inject',
    items: 2,
    tokens: 120,
    hash: 'block-seeded',
    now: FAKE_NOW,
  });
  await rejectValue(s, {
    tenantId: TENANT,
    actor: ACTOR,
    reason: 'wrong',
    value: REFUSED,
  });
  onDb(root, (db) => {
    db.prepare('INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)').run(
      '101',
      TENANT,
      FAKE_NOW,
    );
    db.prepare(
      "INSERT INTO memory_conflicts (memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at, tenant_id) VALUES ('mem_p_plain', 'mem_p_noise', 'seeded contradiction', 0.9, 'open', ?, ?, ?)",
    ).run(FAKE_NOW, FAKE_NOW, TENANT);
    const faded = {
      ...createMemory('the old staging hostname was stg-1', {
        tenantId: TENANT,
      }),
      id: 'mem_d_faded',
    };
    insertDormantRow(db, {
      entry: faded,
      strength: 0.01,
      reason: 'decay',
      dormantAt: FAKE_NOW,
    });
  });
  // SAFETY: MAX(id) over the handoff just pushed returns one row with a numeric id.
  made.handoffId = onDb(root, (db) =>
    Number(
      (
        db.prepare('SELECT MAX(id) AS id FROM session_handoffs').get() as {
          id: number;
        }
      ).id,
    ),
  );
  made.cardId = card.id;
  await s.close();
}

const SESSION_AND_ADMIN_READS: readonly Read[] = [
  read(
    'hippoDb.connectorEvents.eventRecord',
    async (s) => [
      await s.hippoDb.connectorEvents.eventRecord(SLACK_EVENT),
      await s.hippoDb.connectorEvents.eventRecord(
        { connector: 'slack', eventId: 'Ev-unseen' },
        { artifactRef: 'vault:golden:rollout.md', tenantId: TENANT },
      ),
    ],
    /seen: true.*mem_z_vault/,
  ),
  read(
    'hippoDb.connectorEvents.route',
    async (s) => [
      await s.hippoDb.connectorEvents.route({ connector: 'slack', teamId: 'T-seeded' }),
      await s.hippoDb.connectorEvents.route({
        connector: 'github',
        installationId: '101',
      }),
    ],
    `[ { tenantId: '${TENANT}' }, { tenantId: '${TENANT}' } ]`,
  ),
  read(
    'hippoDb.connectorEvents.deadLetters',
    async (s) => [
      await s.hippoDb.connectorEvents.deadLetters('github', TENANT, { limit: 5 }),
      await s.hippoDb.connectorEvents.deadLetters('github', TENANT, { id: 1 }),
    ],
    /unroutable payload.*unroutable payload/,
  ),
  read(
    'hippoDb.connectorEvents.cursor',
    async (s) => [
      await s.hippoDb.connectorEvents.cursor(SLACK_CURSOR),
      await s.hippoDb.connectorEvents.cursor(GITHUB_CURSOR),
    ],
    `[ '1700000000.000100', '2026-01-01T00:00:00Z' ]`,
  ),
  read('hippoDb.connectorEvents.slackWorkspaces', (s) => s.hippoDb.connectorEvents.slackWorkspaces(), 'T-seeded'),
  read(
    'hippoDb.auditMaintenance.objectBackedAmong',
    async (s) =>
      s.hippoDb.auditMaintenance.objectBackedAmong(
        (await s.entriesWhere({ tenantId: TENANT }, { limit: 100 })).entries.map((e) => e.id),
      ),
    /'sem_/,
  ),
  read('lessonWrites.textsHolding', (s) => s.lessonWrites.textsHolding(TENANT, [PLAIN], null), PLAIN),
  read(
    'lessonWrites.contentsWithTag',
    (s) => s.lessonWrites.contentsWithTag(TENANT, 'goal-alpha', undefined),
    'migrate the rollout scripts',
  ),
  read(
    'hippoDb.sessions.read events',
    (s) => s.hippoDb.sessions.read(TENANT, 'event', { sessionId: SESSION, limit: 5 }),
    'canary passed',
  ),
  read(
    'hippoDb.sessions.read latest handoff',
    (s) => s.hippoDb.sessions.read(TENANT, 'handoff', { sessionId: SESSION }, null),
    'handoff after the canary',
  ),
  read(
    'hippoDb.sessions.read handoff by id',
    (s) => s.hippoDb.sessions.read(TENANT, 'handoff', { id: made.handoffId }),
    'handoff after the canary',
  ),
  read(
    'hippoDb.sessions.read working memory',
    (s) => s.hippoDb.sessions.read(TENANT, 'working_memory', { sessionId: SESSION }),
    'watch the canary error rate',
  ),
  read('cards.detail', (s) => s.cards.detail(TENANT, made.cardId), 'cut the eu release'),
  read('cards.detail runs', async (s) => (await s.cards.detail(TENANT, made.cardId))?.runs, 'codex'),
  read('cards.list', (s) => s.cards.list(TENANT, { limit: 10 }), 'cut the eu release'),
  read('goals.sessionGoals', (s) => s.goals.sessionGoals(TENANT, SESSION), 'goal-alpha'),
  read(
    'conflicts.list',
    (s) => s.conflicts.list({ tenantId: TENANT, status: 'open', limit: 5 }),
    'seeded contradiction',
  ),
  read('conflicts.get', (s) => s.conflicts.get(TENANT, 1), 'seeded contradiction'),
  read('dormant.list', (s) => s.dormant.list(TENANT, null, {}), 'stg-1'),
  read('reports.tokenUse', (s) => s.reports.tokenUse(TENANT, '2000-01-01T00:00:00.000Z'), /120/),
  read('reports.failures', (s) => s.reports.failures(TENANT, '2000-01-01T00:00:00.000Z'), /stored/),
  read('reports.memoryStatus', (s) => s.reports.memoryStatus(TENANT, NOW, 0.1), /openConflicts: 1/),
  read(
    'entriesWhere',
    async (s) => [
      await s.entriesWhere({ tenantId: TENANT }, { limit: 3 }),
      await s.entriesWhere(
        { tenantId: TENANT, kinds: ['raw'], live: true, sessionId: SESSION },
        { limit: 10, newest: true },
      ),
      await s.entriesWhere({ tenantId: TENANT, kinds: ['raw'], artifactRefPrefix: 'vault:golden:' }, { limit: 10 }),
      await s.entriesWhere({ tenantId: TENANT, source: 'cli', tag: 'deploy', live: true }, { limit: 10 }),
    ],
    new RegExp(String.raw`id: 'mem_[\s\S]*mem_x_raw[\s\S]*vault:golden:rollout\.md[\s\S]*${PLAIN}`),
  ),
  read('reports.countEntries', (s) => s.reports.countEntries(), /^[1-9]\d*$/),
  read('reports.stats', (s) => s.reports.stats(), /total_recalled/),
  read('reports.statusCounts', (s) => s.reports.statusCounts(NOW, 0.1), /total/),
  read('reports.correctionLinks', (s) => s.reports.correctionLinks({ limit: 10 }), /oldId: 'mem_/),
  read('reports.rawProvenance', (s) => s.reports.rawProvenance({ limit: 10 }), /total: [1-9]/),
  read('reports.createdSinceLastSleep', (s) => s.reports.createdSinceLastSleep(TENANT, NOW), /^[1-9]\d*$/),
  read('rejections.list', (s) => s.rejections.list(TENANT), "reason: 'wrong'"),
  read(
    'rejections.refusedAmong',
    (s) => s.rejections.refusedAmong([{ tenantId: TENANT, entryId: 'mem_new', content: REFUSED }]),
    /^\[ true \]$/,
  ),
  read('failureLog.requestOutcome', (s) => s.failureLog.requestOutcome(TENANT, 'req-seeded', SESSION), "'stored'"),
  read('sharing.sourceTallies', (s) => s.sharing.sourceTallies(TENANT), /count: [1-9]/),
];

/** The groups that were the local files: the ledger, the folder and sharing; the index's sessions run on the writer. */
const FOLDER_GROUP_READS: readonly Read[] = [
  read('folderFiles.home', (s) => s.folderFiles.home(), /folderName: '/),
  read('ledger.lastSent', (s) => s.ledger.lastSent(TENANT, SESSION, 'http_recall'), "hash: 'block-seeded'"),
  read(
    'sharing.entriesWithSignals',
    (s) =>
      s.sharing.entriesWithSignals({ tags: [], sourcePrefix: 'never', minRetrievals: 0, valences: [] }, TENANT, {
        limit: 3,
      }),
    /id: 'mem_/,
  ),
  read('sharing.textKeysPage', (s) => s.sharing.textKeysPage(TENANT, { limit: 3 }), /id: 'mem_/),
  read(
    'sharing.textKeysHolding',
    async (s) => [
      await s.sharing.textKeysHolding({ tenantId: TENANT }, [PLAIN]),
      await s.sharing.textKeysHolding({ tenantId: TENANT, live: true, origins: ['', 'golden'] }, [PLAIN]),
    ],
    /mem_p_plain[\s\S]*mem_p_plain/,
  ),
  read('sharing.takenIds', (s) => s.sharing.takenIds(['mem_p_plain', 'mem_missing']), "[ 'mem_p_plain' ]"),
  read('sharing.searchEntries', (s) => s.sharing.searchEntries('deploy', 50, TENANT), 'mem_p_plain'),
  read(
    'sharing.recallEntries',
    (s) => s.sharing.recallEntries('deploy', { limit: 50, tenantId: TENANT }),
    'mem_p_plain',
  ),
];

const READS: readonly Read[] = [
  read('findApiKey', (s, seed) => s.findApiKey(seed.keyIds[1] ?? ''), "role: 'member'"),
  read(
    'searchRecallEntries',
    (s) =>
      s.searchRecallEntries('deploy', {
        limit: 50,
        tenantId: TENANT,
        explicitScopeMode: 'exact',
        includeSuperseded: false,
        ownScope: undefined,
      }),
    'mem_p_plain',
  ),
  read('entriesByIds', (s) => s.entriesByIds(['mem_p_plain', 'mem_x_summary', 'mem_missing'], TENANT), 'mem_x_summary'),
  read('activeGoals', (s) => s.activeGoals({ sessionId: SESSION, tenantId: TENANT }), 'goal-alpha'),
  read('freshRawEntries', (s) => s.freshRawEntries(2, TENANT, SESSION, null), 'mem_x_raw'),
  read('continuity', (s) => s.continuity(TENANT, 5, null), 'canary passed'),
  read(
    'planningFallacyEvidence',
    (s) => s.planningFallacyEvidence(TENANT, detectForwardClaim('the deploy will take 3 days')?.classQueryTokens ?? []),
    'deploy-duration',
  ),
  read('vectors.embeddingIndexState', (s) => s.vectors.embeddingIndexState(), VECTOR_IDENTITY),
  read(
    'vectors.stored vectors',
    (s) => s.vectors.stored('vectors', VECTOR_IDS),
    /'mem_p_noise' => Float32Array\(8\) \[\s+1, 0, 0, 0,\s+0, 0, 0, 0\s+\]/,
  ),
  read(
    'vectors.nearestEntries',
    (s) =>
      s.vectors.nearestEntries(hashedVector(PLAIN), {
        tenantId: TENANT,
        scope: { mode: 'default-deny' },
        includeSuperseded: false,
      }),
    'mem_p_plain',
  ),
  read('keyWrites.listApiKeys', (s) => s.keyWrites.listApiKeys({ tenantId: TENANT, active: true }), "role: 'member'"),
  read(
    'vectorWrites.entriesWithoutVector',
    (s) =>
      s.vectorWrites.entriesWithoutVector({
        tenantId: ALL_TENANTS,
        model: VECTOR_IDENTITY,
        limit: 5,
      }),
    'mem_p_fill0',
  ),
  // The resolved root both stores open, so their vector writes share one embed turn.
  read('vectorWrites.indexKey', (s) => s.vectorWrites.indexKey(), /[/\\]/),
  read(
    'contextReads.ambientCandidates',
    (s) =>
      s.contextReads.ambientCandidates(TENANT, {
        recentNeeded: 3,
        admit: { currentProject: '', includeCrossProject: true },
      }),
    'mem_p_pinned',
  ),
  read(
    'contextReads.contextCandidates',
    (s) => s.contextReads.contextCandidates(TENANT, { cap: 5, now: NOW }),
    'mem_p_pinned',
  ),
  read(
    'contextReads.ambientTallies',
    (s) => s.contextReads.ambientTallies(TENANT, { currentProject: [], now: NOW }),
    /tagCounts: Map\(\d+\) \{/,
  ),
  read('contextReads.schemaFit', (s) => s.contextReads.schemaFit(TENANT, PLAIN, ['deploy']), /^(0(\.\d+)?|1)$/),
  read('objects.objectById prediction', (s) => s.objects.objectById(TENANT, 'prediction', 1), 'deploy-duration'),
  read(
    'objects.listObjects predictions',
    (s) => s.objects.listObjects(TENANT, 'prediction', { limit: 5 }),
    'deploy-duration',
  ),
  read('dagReads.sessionRawCount', (s) => s.dagReads.sessionRawCount({ tenantId: TENANT, sessionId: SESSION }), /^1$/),
  read(
    'dagReads.sessionRawKeys',
    (s) => s.dagReads.sessionRawKeys({ tenantId: TENANT, sessionId: SESSION, limit: 5 }),
    /contentLength: \d+/,
  ),
  read(
    'dagReads.sessionRawRows',
    (s) => s.dagReads.sessionRawRows({ tenantId: TENANT, sessionId: SESSION, ids: ['mem_x_raw'] }),
    'mem_x_raw',
  ),
  read(
    'dagReads.summaryWithDescendants',
    (s) =>
      s.dagReads.summaryWithDescendants(TENANT, 'mem_x_summary', {
        depth: 2,
        admit: {},
        page: { rows: 1 },
      }),
    'mem_x_child1',
  ),
  read(
    'auditLog.listAuditEvents',
    (s) => s.auditLog.listAuditEvents({ tenantId: TENANT, limit: 5 }),
    "tenantId: 'default'",
  ),
  read(
    'hippoDb.quarantine.list',
    (s) => s.hippoDb.quarantine.list(TENANT, { status: 'all' }),
    'scripts/wipe.sh before every deploy',
  ),
  read('graphReads.graphRows', (s) => s.graphReads.graphRows(TENANT, { limit: 50 }), 'RetryPolicy'),
  read(
    'graphReads.graphRows by memory',
    async (s) =>
      s.graphReads.graphRows(TENANT, {
        by: 'memory',
        ids: (await graphEntities(s)).flatMap((e) => (e.memoryId === null ? [] : [e.memoryId])),
      }),
    /memoryId: '[^']+'/,
  ),
  read(
    'graphReads.graphRows by entity',
    (s) => s.graphReads.graphRows(TENANT, { by: 'entity', ids: Array.from({ length: 50 }, (_, i) => i + 1) }),
    'RetryPolicy',
  ),
  read(
    'graphReads.graphRows by neighbor',
    async (s) =>
      s.graphReads.graphRows(TENANT, { by: 'neighbor', ids: (await graphEntities(s)).map((e) => e.id), limit: 50 }),
    /relType: '[^']+'/,
  ),
  read(
    'graphReads.graphDelta',
    (s) =>
      s.graphReads.graphDelta(TENANT, {
        entities: [
          {
            entityType: 'policy',
            sourceObject: { type: 'policy', id: 1 },
            name: 'Renamed',
            memoryId: null,
          },
        ],
        relations: [],
      }),
    /op: '(update|insert)Entity'/,
  ),
  read('objects.listObjects', (s) => s.objects.listObjects(TENANT, 'decision', { limit: 5 }), 'We adopt RetryPolicy'),
  read('objects.objectById', (s) => s.objects.objectById(TENANT, 'policy', 1), 'retry up to 3x'),
  read(
    'objects.listObjects by memory id',
    async (s) => {
      const memoryId = (await s.objects.listObjects(TENANT, 'decision', { limit: 1 }))[0]?.memoryId ?? '';
      return (await s.objects.listObjects(TENANT, 'decision', { status: 'active', memoryId, limit: 1 }))[0]?.id;
    },
    /^[1-9][0-9]*$/,
  ),
  read(
    'objects.listObjects policies in force',
    (s) => s.objects.listObjects(TENANT, 'policy', { asOf: '9999-12-31T23:59:59.999Z', limit: 5 }),
    'RetryPolicy',
  ),
  read(
    'objects.listObjects active skills by name',
    (s) => s.objects.listObjects(TENANT, 'skill', { byName: true, status: 'active', limit: 5 }),
    'page the owner, then revert',
  ),
  read('objects.briefReceipts', (s) => s.objects.briefReceipts(TENANT, 'deploy', 5), 'mem_p_plain'),
  read('readiness.ping', (s) => s.readiness.ping(), /^undefined$/),
  ...SESSION_AND_ADMIN_READS,
  ...FOLDER_GROUP_READS,
  ...LOCAL_GROUP_READS,
];

interface Write {
  readonly name: string;
  readonly run: Call<string>;
  /** Each in a row or mirror file after the write and in none before it. */
  readonly leaves: readonly string[];
}

function write<T>(name: string, run: Call<T>, leaves: readonly string[]): Write {
  return {
    name,
    run: async (store, seed) => shown(await run(store, seed)),
    leaves,
  };
}

const ACTOR = 'reads-on-readers';
// Its origin is set, so the folders of the two stores leave the same mirror.
const PROMOTED = {
  ...createMemory('promoted note on the rollout', { tenantId: TENANT }),
  id: 'g_promoted',
  originProject: 'golden',
};

const finishRecall: Call<void> = (s, seed) =>
  s.finishRecall({
    goalLog: [
      {
        goalId: seed.templates.goalId,
        memoryId: 'mem_p_goal',
        tenantId: TENANT,
        sessionId: SESSION,
        recalledAt: FAKE_NOW,
        score: 1.6,
      },
    ],
    audit: [
      {
        tenantId: TENANT,
        actor: ACTOR,
        op: 'recall',
        metadata: { results: 2 },
      },
    ],
    trace: {
      tenantId: TENANT,
      sessionId: SESSION,
      pipeline: 'api',
      query: 'deploy',
      results: [
        { memoryId: 'mem_p_plain', score: 2 },
        { memoryId: 'mem_p_new', score: 1 },
      ],
    },
    strengthen: {
      ids: ['mem_p_plain', 'mem_p_new', 'mem_missing'],
      opts: { tenantId: TENANT, recallBoostAblated: false },
    },
  });

const WRITES: readonly Write[] = [
  write(
    'appendAuditEvents',
    (s) =>
      s.appendAuditEvents([
        {
          tenantId: TENANT,
          actor: ACTOR,
          op: 'recall',
          targetId: 'mem_p_plain',
        },
        {
          tenantId: TENANT,
          actor: ACTOR,
          op: 'recall_availability_detected',
          metadata: { share: 0.9 },
        },
      ]),
    ['"op":"recall_availability_detected"', `"actor":"${ACTOR}","op":"recall","target_id":"mem_p_plain"`],
  ),
  write('finishRecall', finishRecall, [
    'goalRecallLog {',
    `"actor":"${ACTOR}","op":"recall"`,
    'traceResults {',
    'retrieved {"id":"mem_p_new","retrieval_count":1',
  ]),
  write('bumpRecallStats', (s) => s.bumpRecallStats(3), [
    'stats {"key":"total_recalled","value":"3"}',
    '"total_recalled": 3',
  ]),
  write(
    'vectorWrites.writeVectors',
    (s) =>
      s.vectorWrites.writeVectors({
        tenantId: TENANT,
        model: VECTOR_IDENTITY,
        replaceIndex: false,
        rows: [
          { memoryId: 'mem_p_pinned', vector: hashedVector('deploy freeze') },
          { memoryId: 'mem_missing', vector: [1] },
        ],
      }),
    ['vectors {"memory_id":"mem_p_pinned"'],
  ),
  write('hippoDb.quarantine.approve', (s, seed) => s.hippoDb.quarantine.approve(TENANT, seed.held[0] ?? '', ACTOR), [
    '"status":"approved"',
    '"op":"quarantine_approve"',
  ]),
  write('hippoDb.quarantine.reject', (s, seed) => s.hippoDb.quarantine.reject(TENANT, seed.held[1] ?? '', ACTOR), [
    '"status":"rejected"',
    '"op":"quarantine_reject"',
  ]),
  write(
    'promotion.writeCopy',
    (s) =>
      s.promotion.writeCopy(PROMOTED, {
        actor: ACTOR,
        sourceId: 'mem_p_plain',
        auditAs: { tenantId: TENANT, actor: ACTOR },
      }),
    ['memories {"id":"g_promoted"', `"actor":"${ACTOR}","op":"promote","target_id":"g_promoted"`],
  ),
];

let seed: MovedReadsSeed;
const homes: string[] = [];

/** A fresh copy of the seeded store; the copies are removed after the file's stores have closed. */
function copy(): string {
  const made = freshStore(seed.templates, 'local');
  homes.push(made.home);
  return made.root;
}

// Seeding the template stores row by row runs past the 30 s hook default on a slow runner.
beforeAll(async () => {
  seed = await seedMovedReads();
}, 120_000);

afterAll(() => {
  for (const dir of [seed.templates.dir, ...homes]) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

afterEach(undoAll);

describe('a read the op table places on a reader thread', () => {
  let onWorkers: HippoDbStore;
  let inProcess: HippoDbStore;

  // Reads write nothing, so both stores serve one copy for the whole table.
  beforeAll(async () => {
    const root = copy();
    // The shared seed has no skill, and the skill read must find one.
    await cliSave(root, TENANT, SKILL, {
      skillName: 'rollback',
      instructions: 'page the owner, then revert',
    });
    // Nor a raw row under an artifact ref; its id sorts last, so the backfill read's first page keeps its rows.
    const raw = createMemory('raw vault note on the rollout', {
      kind: 'raw',
      artifactRef: 'vault:golden:rollout.md',
      tenantId: TENANT,
    });
    writeEntry(root, { ...raw, id: 'mem_z_vault' });
    await seedSessionAndAdmin(root);
    await seedLocalGroups(root);
    onWorkers = workerSqliteStore(root);
    inProcess = sqliteStore(root);
  });

  afterAll(async () => {
    await onWorkers.close();
    await inProcess.close();
  });

  it('has a row here for every method tagged read or pinned-read', () => {
    const local = Object.entries(HIPPO_DB_OPS).map(([repo, places]) => [`hippoDb.${repo}`, places] as const);
    const tagged = [...Object.entries(WORKER_OPS), ...local].flatMap(([group, places]) =>
      Object.entries(places)
        .filter(([, place]) => place === 'read' || place === 'pinned-read')
        .map(([method]) => (group === 'base' ? method : `${group}.${method}`)),
    );

    // A row named `<method> <case>` is one more case of that method.
    expect([...new Set(READS.map((row) => row.name.split(' ')[0]))].sort()).toEqual(tagged.sort());
  });

  it.each(READS)('$name answers as the in-process store does', async ({ run, shows }) => {
    const answer = await run(onWorkers, seed);

    expect(answer).toBe(await run(inProcess, seed));
    expect(answer).toMatch(shows);
  });

  it('answers every one of them while a write waits for the write lock', async () => {
    const root = copy();
    const { store, sent } = patientStore(root);
    cleanups.push(() => store.close());
    await store.bumpRecallStats(1);
    await Promise.all([store.readiness.ping(), store.readiness.ping()]);
    const lock = holdWriteLock(root);
    const blocked = store.bumpRecallStats(1);
    await sent('base.bumpRecallStats', 2);

    for (const { name, run } of READS) {
      let answered = false;
      const answer = run(store, seed);
      const settle = (): void => {
        answered = true;
      };
      void answer.then(settle, settle);
      // A read sent to the writer thread waits behind the blocked write until the lock is let go, which is only below.
      await waitFor(() => answered, {
        what: `${name} to answer with the write lock held`,
      });
      await answer;
    }
    lock.release();
    await blocked;
  });
});

describe('a write the op table places on the writer thread', () => {
  const left = (root: string): string[] => [...leftBehind(root), ...mirrorFiles(root)];

  it.each(WRITES)('$name leaves the rows and mirror files the in-process store leaves', async ({ run, leaves }) => {
    const [workerRoot, inProcessRoot] = [copy(), copy()];
    const before = left(workerRoot);
    const onWorkers = workerSqliteStore(workerRoot);
    const inProcess = sqliteStore(inProcessRoot);
    cleanups.push(
      () => onWorkers.close(),
      () => inProcess.close(),
    );

    const answer = await run(onWorkers, seed);

    expect(answer).toBe(await run(inProcess, seed));
    const after = left(workerRoot);
    expect(after).toEqual(left(inProcessRoot));
    for (const text of leaves) {
      expect(after.filter((line) => line.includes(text))).not.toEqual([]);
      expect(before.filter((line) => line.includes(text))).toEqual([]);
    }
  });
});

describe('vectors from a reader thread', () => {
  it('come back with their ids, lengths and values, a row with no numbers included', () => {
    const stored = new Map([
      ['a', new Float32Array([1, 2, 3])],
      ['none', new Float32Array(0)],
      ['b', new Float32Array([0.5])],
    ]);

    const pack = packVectors(stored);

    expect(vectorViewsOf(pack)).toEqual(stored);
    expect(vectorViewsOf(packVectors(new Map()))).toEqual(new Map());
  });

  it('are an empty answer with no thread asked when no id is named', async () => {
    const { store, ops } = patientStore(copy());
    cleanups.push(() => store.close());

    expect(await store.vectors.stored('vectors', [])).toEqual(new Map());
    expect(ops).toEqual([]);
  });
});
