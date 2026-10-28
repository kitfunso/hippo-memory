// Drives every vetted writer with a control token beside a secret, then scans every table, full-text shadow table and mirror file: each column holds its control and nothing holds the secret.
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createApiKey, grantScope } from '../../src/store/sqlite/auth.js';
import { appendAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertSummarizedCompaction } from '../../src/store/sqlite/compaction-rows.js';
import { writeDeliveryEventOnHandle } from '../../src/store/sqlite/delivery-ledger.js';
import { insertTokenRow } from '../../src/store/sqlite/token-ledger-rows.js';
import { remember, retrieve } from '../../src/api/index.js';
import type { DeliveryEventInput } from '../../src/base/session/delivery.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { insertEntityRow } from '../../src/store/sqlite/graph-writes.js';
import { recordQuarantine } from '../../src/store/sqlite/quarantine.js';
import { parkInDlq } from '../../src/surface/connectors/dlq.js';
import { gatedWrite } from '../../src/store/sqlite/gated-write.js';
import { storeFilesOf } from '../_helpers/test-session.js';
import { githubDlq } from '../../src/surface/connectors/github/dlq.js';
import { slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { openIncident, resolveOpenIncident } from '../../src/domain/objects/incidents.js';
import { PROCESS } from '../../src/domain/objects/processes.js';
import { SKILL } from '../../src/domain/objects/skills.js';
import { POLICY } from '../../src/domain/objects/policies.js';
import { PROJECT_BRIEF } from '../../src/domain/objects/project-briefs.js';
import { CUSTOMER_NOTE } from '../../src/domain/objects/customer-notes.js';
import { DECISION } from '../../src/domain/objects/decisions.js';
import { loadConfig } from '../../src/host/config-file.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { cliSave } from '../_helpers/cli-save-site.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { savePrediction } from '../_helpers/save-prediction.js';
import { storeRefinement } from '../../src/api/memories/refine.js';
import { importEntries } from '../../src/entry/importers.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { closePrediction } from '../_helpers/root-forms.js';
import { replaceDetectedConflicts } from '../_helpers/root-forms-parts/conflicts.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import type { SessionEventInput, SnapshotInput, WorkingMemoryPush } from '../../src/base/ports/store/sessions.js';
import type { HandoffOutcome, SessionHandoff } from '../../src/base/session/handoff.js';
import { COLUMN_CLASSES, type ColumnClass } from './secret-boundary-census.js';

const FILL = runtimeJoin('Zq7', 'x'.repeat(30), 'Lm9');
const SECRET = runtimeJoin('ghp_', FILL);
const TENANT = 'default';

/** Case-blind, since tags and search keys lower-case their text. */
function leaks(value: string): boolean {
  return value.toLowerCase().includes(FILL.toLowerCase());
}

/** Columns a writer fills from another column's text, so they carry that column's control. */
const SAME_TEXT = new Map([
  ['memories_fts.content', 'memories.content'],
  ['memories_fts_content.c1', 'memories.content'],
  ['memories_trigram.content', 'memories.content'],
  ['dormant_memories.entry_json', 'dormant_memories.content'],
  ['raw_archive.payload_json', 'raw_archive.reason'],
]);

function control(column: string): string {
  return `ctl${(SAME_TEXT.get(column) ?? column).replace(/[^a-z0-9]/g, '')}`;
}

/** The text a writer gets for one column: its control token, then the secret. */
function text(column: string): string {
  return `${control(column)} ${SECRET}`;
}

let root: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

async function driveMemories(): Promise<string> {
  const store = sqliteStore(root);
  const entry = createMemory(text('memories.content'), { source: text('memories.source') });
  await store.entryWrites.writeEntry({ entry, actor: 'tester' });
  const dormant = createMemory(text('dormant_memories.content'));
  withDb((db) =>
    insertDormantRow(db, { entry: dormant, strength: 0.1, reason: 'decay', dormantAt: '2026-03-01T00:00:00.000Z' }),
  );
  const raw = createMemory('raw transcript line', { kind: 'raw' });
  await store.entryWrites.writeEntry({ entry: raw, actor: 'tester' });
  const target = { tenantId: TENANT, actor: 'tester', ownScope: null, role: 'admin' } as const;
  await store.entryWrites.archiveRaw({ ...target, id: raw.id, reason: text('raw_archive.reason') });
  const other = createMemory('the deploy runs on tuesdays');
  await store.entryWrites.writeEntry({ entry: other, actor: 'tester' });
  replaceDetectedConflicts(root, [
    { memory_a_id: entry.id, memory_b_id: other.id, reason: text('memory_conflicts.reason'), score: 1 },
  ]);
  await store.rejections.apply({
    tenantId: TENANT,
    actor: 'tester',
    ownScope: null,
    value: 'the build is red',
    reason: text('rejected_values.reason'),
  });
  const refined = createMemory('a merged memory before its rewrite');
  await store.entryWrites.writeEntry({ entry: refined, actor: 'tester' });
  await storeRefinement(apiCtx(root, TENANT, { subject: 'tester', role: 'admin' }), refined, text('memories.content'));
  importEntries([text('memories.content')], text('memories.source'), [], { hippoRoot: root, tenantId: TENANT });
  return other.id;
}

function driveRows(memoryId: string): void {
  withDb((db) => {
    createApiKey(db, { tenantId: TENANT, label: text('api_keys.label') });
    appendAuditEvents(db, [
      {
        tenantId: TENANT,
        actor: 'tester',
        op: 'remember',
        targetId: text('audit_log.target_id'),
        metadata: { note: text('audit_log.metadata_json') },
      },
    ]);
    const meta = {
      sessionId: 's1',
      originProject: 'p',
      trigger: null,
      cwd: text('compactions.cwd'),
      transcriptPath: text('compactions.transcript_path'),
      startedAt: '2026-03-01T00:00:00.000Z',
    };
    insertSummarizedCompaction(db, TENANT, meta, {
      id: 'c1',
      summary: text('compactions.summary'),
      itemsJson: JSON.stringify([text('compactions.items_json')]),
      summarizedAt: '2026-03-01T00:00:00.000Z',
    });
    insertEntityRow(db, TENANT, { entityType: 'system', name: text('entities.name'), memoryId });
    recordQuarantine(db, {
      tenantId: TENANT,
      memoryId,
      originalScope: null,
      reason: text('memory_quarantine.reason'),
      actor: 'tester',
    });
  });
}

async function driveSessions(): Promise<void> {
  const { sessions, cards, goals } = sqliteStore(root);
  await sessions.save(
    TENANT,
    'snapshot',
    {
      task: text('task_snapshots.task'),
      summary: text('task_snapshots.summary'),
      nextStep: text('task_snapshots.next_step'),
      source: text('task_snapshots.source'),
      sessionId: 's1',
    },
    null,
  );
  await sessions.save(TENANT, 'event', {
    sessionId: 's1',
    eventType: 'note',
    source: text('session_events.source'),
    task: text('session_events.task'),
    content: text('session_events.content'),
    metadata: { note: text('session_events.metadata_json') },
  });
  await sessions.save(
    TENANT,
    'handoff',
    {
      handoff: {
        version: 1,
        sessionId: 's1',
        repoRoot: text('session_handoffs.repo_root'),
        taskId: text('session_handoffs.task_id'),
        summary: text('session_handoffs.summary'),
        nextAction: text('session_handoffs.next_action'),
        artifacts: [text('session_handoffs.artifacts_json')],
        constraints: [text('session_handoffs.constraints_json')],
        evidence: { gitRef: text('session_handoffs.evidence_json') },
      },
    },
    null,
  );
  await sessions.save(TENANT, 'working_memory', {
    scope: 'repo',
    taskId: text('working_memory.task_id'),
    content: text('working_memory.content'),
    metadata: { note: text('working_memory.metadata_json') },
  });
  const card = await cards.create(TENANT, {
    title: text('cards.title'),
    contract: text('cards.contract'),
    repo: text('cards.repo'),
  });
  await cards.comment(TENANT, card.id, text('card_comments.author'), text('card_comments.body'));
  await goals.push(TENANT, {
    sessionId: 's1',
    goalName: text('goal_stack.goal_name'),
    successCondition: text('goal_stack.success_condition'),
  });
  await parkInDlq(githubDlq, sqliteStore(root), {
    tenantId: TENANT,
    rawPayload: text('github_dlq.raw_payload'),
    error: text('github_dlq.error'),
  });
  await parkInDlq(slackDlq, sqliteStore(root), {
    tenantId: TENANT,
    rawPayload: text('slack_dlq.raw_payload'),
    error: text('slack_dlq.error'),
  });
}

async function driveObjects(): Promise<void> {
  const halfLife = loadConfig(root).defaultHalfLifeDays;
  const by = { actor: 'cli', now: evalNow() };
  await cliSave(root, TENANT, DECISION, {
    decisionText: text('decisions.decision_text'),
    context: text('decisions.context'),
  });
  const incident = await openIncident(objectsAt(root), {
    baseHalfLifeDays: halfLife,
    tenantId: TENANT,
    opts: { incidentText: text('incidents.incident_text'), context: text('incidents.context') },
    by,
  });
  await resolveOpenIncident(objectsAt(root), {
    tenantId: TENANT,
    id: incident.id,
    resolutionText: text('incidents.resolution_text'),
    by,
  });
  const prediction = await savePrediction(root, TENANT, {
    classTag: 'effort',
    claimText: text('predictions.claim_text'),
    estimateValue: 2,
    estimateUnit: text('predictions.estimate_unit'),
  });
  await closePrediction(root, TENANT, prediction.id, {
    closureState: 'closed',
    actualValue: 3,
    closureNote: text('predictions.closure_note'),
  });
  const p1 = await cliSave(root, TENANT, PROCESS, {
    processName: text('processes.process_name'),
    description: text('processes.description'),
    steps: [text('processes.steps')],
  });
  await cliSave(root, TENANT, PROCESS, {
    processName: 'release',
    steps: ['tag'],
    supersedesProcessId: p1.id,
    changeSummary: text('processes.change_summary'),
  });
  const s1 = await cliSave(root, TENANT, SKILL, {
    skillName: text('skills.skill_name'),
    instructions: text('skills.instructions'),
    trigger: text('skills.trigger_text'),
  });
  await cliSave(root, TENANT, SKILL, {
    skillName: 'tests',
    instructions: 'run them',
    supersedesSkillId: s1.id,
    changeSummary: text('skills.change_summary'),
  });
  const pol = await cliSave(root, TENANT, POLICY, {
    policyName: text('policies.policy_name'),
    policyText: text('policies.policy_text'),
  });
  await cliSave(root, TENANT, POLICY, {
    policyName: 'retry',
    policyText: 'three times',
    supersedesPolicyId: pol.id,
    changeSummary: text('policies.change_summary'),
  });
  const brief = await cliSave(root, TENANT, PROJECT_BRIEF, {
    repo: text('project_briefs.repo'),
    summary: text('project_briefs.summary'),
  });
  await cliSave(root, TENANT, PROJECT_BRIEF, {
    repo: text('project_briefs.repo'),
    summary: 'billing',
    supersedesBriefId: brief.id,
    changeSummary: text('project_briefs.change_summary'),
  });
  const note = await cliSave(root, TENANT, CUSTOMER_NOTE, {
    customer: text('customer_notes.customer'),
    note: text('customer_notes.note'),
  });
  await cliSave(root, TENANT, CUSTOMER_NOTE, {
    customer: 'acme',
    note: 'renewal',
    supersedesNoteId: note.id,
    changeSummary: text('customer_notes.change_summary'),
  });
}

/** One column that holds text after the drives, with every text value in it. */
interface HeldColumn {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
}

/** Every column of every table, full-text shadow tables included, whose values sqlite types as text. */
function scanStore(): HeldColumn[] {
  return withDb((db) => {
    // SAFETY: the SELECT projects sqlite_master's name column only.
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    return tables.flatMap(({ name: table }) => {
      // SAFETY: table_xinfo returns one row per column, name among them; fts5 columns carry no declared type.
      const columns = db.prepare(`SELECT name FROM pragma_table_xinfo(?)`).all(table) as { name: string }[];
      return columns.flatMap(({ name: column }) => {
        const sql = `SELECT "${column}" AS v FROM "${table}" WHERE typeof("${column}") = 'text' AND "${column}" <> ''`;
        // SAFETY: the WHERE keeps text values only.
        const values = (db.prepare(sql).all() as { v: string }[]).map((r) => r.v);
        return values.length === 0 ? [] : [{ table, column, values }];
      });
    });
  });
}

function mirrorFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return mirrorFiles(full);
    return d.name.startsWith('hippo.db') ? [] : [full];
  });
}

const VETTED = [...COLUMN_CLASSES].flatMap(([column, cls]) => ('vetted' in cls ? [column] : []));
const REFUSED = [...COLUMN_CLASSES].flatMap(([column, cls]) => ('refused' in cls ? [column] : []));

const KEY = `k-${SECRET}`;

// The FTS tables' hidden columns and sqlite_sequence.seq hold no caller text.
const SCHEMA_EXCEPTIONS: ReadonlySet<string> = new Set([
  'memories_fts.memories_fts',
  'memories_fts.rank',
  'memories_trigram.memories_trigram',
  'memories_trigram.rank',
  'sqlite_sequence.seq',
]);

const sessions = () => sqliteStore(root).sessions;
const event = (over: Partial<SessionEventInput>) =>
  sessions().save(TENANT, 'event', { sessionId: 's1', eventType: 'note', content: 'x', ...over });
const wm = (over: Partial<WorkingMemoryPush>) =>
  sessions().save(TENANT, 'working_memory', { scope: 'repo', content: 'x', ...over });
const handoff = (over: Partial<SessionHandoff>) =>
  sessions().save(TENANT, 'handoff', { handoff: { version: 1, sessionId: 's1', summary: 'x', ...over } }, null);
const snapshot = (over: Partial<SnapshotInput>) =>
  sessions().save(TENANT, 'snapshot', { task: 't', summary: 's', nextStep: 'n', ...over }, null);
const goals = () => sqliteStore(root).goals;
const admin = () => apiCtx(root, TENANT, { subject: 'tester', role: 'admin' });
const remembered = (over: Partial<Parameters<typeof remember>[1]>) =>
  remember(admin(), { content: 'the deploy runs on tuesdays', ...over });
const compaction = (over: Partial<{ sessionId: string; trigger: string; cwd: string; transcriptPath: string }>) =>
  withDb((db) =>
    insertSummarizedCompaction(
      db,
      TENANT,
      { sessionId: 's1', originProject: 'p', trigger: null, cwd: null, transcriptPath: null, startedAt: AT, ...over },
      { id: 'c-key', summary: 's', itemsJson: '[]', summarizedAt: AT },
    ),
  );
const claimed = async (runtime: string, sessionId?: string) => {
  const card = await sqliteStore(root).cards.create(TENANT, { title: 'claim me' });
  return sqliteStore(root).cards.claim(TENANT, card.id, runtime, sessionId);
};
const AT = '2026-03-01T00:00:00.000Z';

/** A delivery event as the prompt hook writes it, with `over` on top. */
function delivery(over: Partial<DeliveryEventInput>): DeliveryEventInput {
  return {
    ts: AT,
    tenantId: TENANT,
    runtime: 'claude-code',
    eventType: 'prompt-submit',
    surface: 'hook',
    storeHash: 'aaaaaaaaaaaaaaaa',
    writeStore: 'local',
    projectHash: null,
    sessionId: 'sess-1',
    sessionState: 'payload',
    hostTurnId: null,
    promptHash: null,
    promptLength: 0,
    queryHash: null,
    recallTraceId: null,
    blockState: 'sent',
    promptRecall: false,
    consideredCount: 0,
    filteredCount: 0,
    selectedCount: 0,
    emittedCount: 0,
    rejectedCount: 0,
    rejectedUnlisted: 0,
    sectionsShown: 0,
    sectionsDropped: 0,
    budgetTokens: 0,
    selectedTokens: 0,
    injectedTokens: 0,
    staticHash: null,
    recallHash: null,
    emittedHash: null,
    elapsedMs: 0,
    toolUseId: null,
    failureId: null,
    candidates: [],
    ...over,
  };
}

// The delivery ledger is fail-soft, so it skips the row and logs; a clean twin of the same write lands, which shows the key is why.
const deliveryRefuses = (over: (key: string) => Partial<DeliveryEventInput>) => async () => {
  expect(withDb((db) => writeDeliveryEventOnHandle(db, delivery(over('clean-key'))))).not.toBeNull();
  if (withDb((db) => writeDeliveryEventOnHandle(db, delivery(over(KEY)))) === null) {
    throw new Error('holds secret-shaped text: the fail-soft ledger skipped the row');
  }
};

/** For each key column, the API write that sends it a secret-shaped key. */
const KEY_WRITES = {
  'api_key_scope_grants.scope': async () => withDb((db) => grantScope(db, 'hk_grant', KEY)),
  'api_keys.tenant_id': async () => withDb((db) => createApiKey(db, { tenantId: KEY, label: 'k' })),
  'api_keys.owner_subject': async () =>
    withDb((db) => createApiKey(db, { tenantId: TENANT, label: 'k', ownerSubject: KEY })),
  'card_runs.runtime': () => claimed(KEY),
  'card_runs.session_id': () => claimed('claude-code', KEY),
  'cards.assignee_runtime': () => claimed(KEY),
  'compactions.session_id': async () => compaction({ sessionId: KEY }),
  'compactions.compact_trigger': async () => compaction({ trigger: KEY }),
  // SAFETY: an untyped hook payload can send any string as the runtime, and the row keeps it as given.
  'delivery_events.runtime': deliveryRefuses((key) => ({ runtime: key as DeliveryEventInput['runtime'] })),
  'delivery_events.session_id': deliveryRefuses((key) => ({ sessionId: key })),
  'delivery_events.host_turn_id': deliveryRefuses((key) => ({ hostTurnId: key })),
  'delivery_events.tool_use_id': deliveryRefuses((key) => ({ eventType: 'tool-failure', toolUseId: key })),
  'failure_log.session_id': () =>
    sqliteStore(root).failureLog.record({ tenantId: TENANT, outcome: 'stored', sessionId: KEY }),
  'failure_log.tool': () => sqliteStore(root).failureLog.record({ tenantId: TENANT, outcome: 'stored', tool: KEY }),
  'failure_log.owner_subject': () =>
    sqliteStore(root).failureLog.record({ tenantId: TENANT, outcome: 'stored', ownerSubject: KEY }),
  'goal_recall_log.session_id': () => retrieve(admin(), { query: 'deploy', boost: { sessionId: KEY } }),
  'memories.scope': () => remembered({ scope: KEY }),
  'memories.owner': () => remembered({ owner: KEY }),
  'memories.artifact_ref': () => remembered({ artifactRef: KEY }),
  'memories.source_session_id': () => remembered({ local: { sourceSessionId: KEY } }),
  'memories.tags_json': () => remembered({ tags: [KEY] }),
  'recall_traces.session_id': () => retrieve(admin(), { query: 'deploy', boost: { sessionId: KEY } }),
  'session_owners.session_id': () => sessions().bindSessionOwner(TENANT, KEY, 'owner-a', 60_000),
  'session_owners.owner_subject': () => sessions().bindSessionOwner(TENANT, 's-owner', KEY, 60_000),
  'token_ledger.session_id': async () =>
    withDb((db) =>
      insertTokenRow(db, {
        ts: AT,
        tenantId: TENANT,
        sessionId: KEY,
        surface: 'hook',
        event: 'e',
        items: 0,
        tokens: 0,
        blockHash: null,
      }),
    ),
  'session_events.session_id': () => event({ sessionId: KEY }),
  'session_events.event_type': () => event({ eventType: KEY }),
  'session_events.scope': () => event({ scope: KEY }),
  'working_memory.scope': () => wm({ scope: KEY }),
  'working_memory.session_id': () => wm({ sessionId: KEY }),
  'session_handoffs.session_id': () => handoff({ sessionId: KEY }),
  'session_handoffs.scope': () => handoff({ scope: KEY }),
  // SAFETY: an untyped caller can send any string here, and the row keeps it as given.
  'session_handoffs.outcome': () => handoff({ outcome: KEY as HandoffOutcome }),
  'session_handoffs.target_runtime': () => handoff({ targetRuntime: KEY }),
  'session_handoffs.card_id': () => handoff({ cardId: KEY }),
  'goal_stack.session_id': () => goals().push(TENANT, { sessionId: KEY, goalName: 'g' }),
  'goal_stack.parent_goal_id': () => goals().push(TENANT, { sessionId: 's1', goalName: 'g', parentGoalId: KEY }),
  'predictions.class_tag': () =>
    savePrediction(root, TENANT, { classTag: KEY, claimText: 'the release ships on friday', estimateValue: 1 }),
  'task_snapshots.session_id': () => snapshot({ sessionId: KEY }),
  'task_snapshots.scope': () => snapshot({ scope: KEY }),
};

/** For each enum a caller feeds, the src function that bounds it and a write that sends it a value off its list. */
const ENUM_ENTRANCES = {
  'task_snapshots.status': {
    by: 'clearActiveTaskSnapshot',
    write: async () => {
      await snapshot({ sessionId: 's-enum' });
      await sessions().clear(TENANT, 'snapshot', { status: KEY });
    },
  },
};

let scan: HeldColumn[];

beforeAll(async () => {
  root = makeRoot('secret-boundary');
  const memoryId = await driveMemories();
  driveRows(memoryId);
  await driveSessions();
  await driveObjects();
  scan = scanStore();
});

describe('the secret boundary over the whole store', () => {
  it.each(VETTED)('%s holds its control token and no secret', (column) => {
    const values = scan.find((held) => `${held.table}.${held.column}` === column)?.values ?? [];
    expect(values.some((v) => v.includes(control(column)))).toBe(true);
    expect(values.filter((v) => leaks(v))).toEqual([]);
  });

  it('no column in any table holds the secret', () => {
    const leaked = scan.filter((held) => held.values.some(leaks)).map((held) => `${held.table}.${held.column}`);
    expect(leaked).toEqual([]);
  });

  it('every column that holds text is classed in the census', () => {
    const unclassed = scan
      .filter((held) => !COLUMN_CLASSES.has(`${held.table}.${held.column}`))
      .map((held) => `${held.table}.${held.column}`);
    expect(unclassed).toEqual([]);
  });

  it('every text or untyped column of a fresh store is classed in the census', () => {
    const fresh = openHippoDb(makeRoot('secret-boundary-schema'));
    try {
      // SAFETY: the SELECT projects sqlite_master's name column only.
      const tables = fresh.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
      const unclassed = tables.flatMap(({ name: table }) => {
        // SAFETY: table_xinfo returns one row per column with its name and declared type.
        const columns = fresh.prepare(`SELECT name, type FROM pragma_table_xinfo(?)`).all(table) as {
          name: string;
          type: string;
        }[];
        return columns
          .filter((c) => c.type === '' || /TEXT|CHAR|CLOB/i.test(c.type))
          .map((c) => `${table}.${c.name}`)
          .filter((column) => !COLUMN_CLASSES.has(column) && !SCHEMA_EXCEPTIONS.has(column));
      });
      expect(unclassed).toEqual([]);
    } finally {
      closeHippoDb(fresh);
    }
  });

  it('no mirror file holds the secret', () => {
    const files = mirrorFiles(root);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => leaks(fs.readFileSync(f, 'utf8')))).toEqual([]);
  });

  it.each(['memories_fts', 'memories_trigram'])('%s finds the control and not the secret', (table) => {
    const hits = (q: string): number =>
      // SAFETY: count(*) returns one row shaped { n }.
      withDb(
        (db) =>
          (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`"${q}"`) as { n: number }).n,
      );
    expect(hits(control('memories.content'))).toBeGreaterThan(0);
    expect(hits(FILL)).toBe(0);
  });
});

/** Every function or constant src declares, so a census `by` that names one can be checked to exist. */
function srcDeclarations(dir: string): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(file.parentPath, file.name), 'utf8');
    for (const m of src.matchAll(/\b(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  }
  return names;
}

/** Why a class fails the census rule, or null: a sourced out names hippo, the operator, or a src function that exists. */
function unsourced(cls: ColumnClass, declared: ReadonlySet<string>): string | null {
  if (!('out' in cls) || !['id', 'enum', 'path', 'tag label'].includes(cls.out)) return null;
  const by = 'by' in cls ? cls.by : undefined;
  if (by === undefined) return 'names no source';
  if (by === 'hippo' || by === 'operator' || declared.has(by)) return null;
  return `names ${by}, which src does not declare`;
}

describe('key columns', () => {
  it('every out id, enum, path or tag label names hippo, the operator, or a src function that bounds it', () => {
    const declared = srcDeclarations(path.join(import.meta.dirname, '../../src'));
    const bad = [...COLUMN_CLASSES].flatMap(([column, cls]) => {
      const why = unsourced(cls, declared);
      return why === null ? [] : [`${column} ${why}`];
    });
    expect(bad).toEqual([]);
  });

  it('every key column the census refuses has a write that sends it a secret', () => {
    expect(Object.keys(KEY_WRITES).sort()).toEqual([...REFUSED].sort());
  });

  it.each(Object.entries(KEY_WRITES))('%s refuses a secret-shaped key and stores nothing', async (column, write) => {
    await expect(write()).rejects.toThrow(/holds secret-shaped text/);
    const table = column.slice(0, column.indexOf('.'));
    const name = column.slice(column.indexOf('.') + 1);
    // SAFETY: count(*) returns one row shaped { n }.
    const held = withDb(
      (db) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE instr("${name}", ?) > 0`).get(FILL) as { n: number },
    );
    expect(held.n).toBe(0);
  });
});

describe('caller-fed enums', () => {
  it.each(Object.entries(ENUM_ENTRANCES))('%s names the src function that bounds it', (column, { by }) => {
    expect(COLUMN_CLASSES.get(column)).toEqual({ out: 'enum', by });
  });

  it.each(Object.entries(ENUM_ENTRANCES))('%s refuses a value off its list and stores nothing', async (column, e) => {
    await expect(e.write()).rejects.toThrow(/not one of/);
    const table = column.slice(0, column.indexOf('.'));
    const name = column.slice(column.indexOf('.') + 1);
    // SAFETY: count(*) returns one row shaped { n }.
    const held = withDb(
      (db) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE instr("${name}", ?) > 0`).get(FILL) as { n: number },
    );
    expect(held.n).toBe(0);
  });
});

describe('writers behind the capture gate', () => {
  it('store a strict-only secret the gate lets through as redacted text', () => {
    const jwt = runtimeJoin('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiI5ODc2In0', '.', 'Z2F0ZWQtc2lnbmF0dXJl');
    const entry = createMemory(`The release bot calls the deploy hook with ${jwt} every Monday morning.`);
    expect(withDb((db) => gatedWrite(db, storeFilesOf(root), entry))).toBe('written');
    const stored = withDb((db) => db.prepare('SELECT content FROM memories WHERE id = ?').get(entry.id));
    expect(stored).toEqual({ content: 'The release bot calls the deploy hook with [REDACTED] every Monday morning.' });
    expect(mirrorFiles(root).filter((f) => fs.readFileSync(f, 'utf8').includes(jwt))).toEqual([]);
  });
});
