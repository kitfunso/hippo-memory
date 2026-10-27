// Drives every vetted writer with a control token beside a secret, then scans every table, full-text shadow table and mirror file: each column holds its control and nothing holds the secret.
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { appendAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertSummarizedCompaction } from '../../src/store/sqlite/compaction-rows.js';
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
import { closePrediction } from '../_helpers/root-forms.js';
import { replaceDetectedConflicts } from '../_helpers/root-forms-parts/conflicts.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { COLUMN_CLASSES } from './secret-boundary-census.js';

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
  return other.id;
}

function driveRows(memoryId: string): void {
  withDb((db) => {
    createApiKey(db, { tenantId: TENANT, label: text('api_keys.label') });
    appendAuditEvents(db, [
      { tenantId: TENANT, actor: 'tester', op: 'remember', metadata: { note: text('audit_log.metadata_json') } },
    ]);
    const meta = {
      sessionId: 's1',
      originProject: 'p',
      trigger: null,
      cwd: null,
      transcriptPath: null,
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
      sessionId: 's1',
    },
    null,
  );
  await sessions.save(TENANT, 'event', {
    sessionId: 's1',
    eventType: 'note',
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
    content: text('working_memory.content'),
    metadata: { note: text('working_memory.metadata_json') },
  });
  const card = await cards.create(TENANT, { title: text('cards.title'), contract: text('cards.contract') });
  await cards.comment(TENANT, card.id, 'tester', text('card_comments.body'));
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
    repo: 'acme/billing',
    summary: text('project_briefs.summary'),
  });
  await cliSave(root, TENANT, PROJECT_BRIEF, {
    repo: 'acme/billing',
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

let scan: HeldColumn[];

beforeAll(async () => {
  root = makeRoot('secret-boundary');
  const memoryId = await driveMemories();
  driveRows(memoryId);
  await driveSessions();
  await driveObjects();
  scan = scanStore();
}, 120_000);

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
