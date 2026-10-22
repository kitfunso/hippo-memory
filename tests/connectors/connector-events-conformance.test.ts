// ConnectorEvents answers alike on hippo.db and on a store held in memory: the same answers, entries, event log rows, dead letters
// and audit rows, over two tenants that hold rows under the same artifact refs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type { AuditEvent } from '../../src/entry/store-kit.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type {
  ConnectorDeadLetter,
  ConnectorEvent,
  ConnectorEventRecord,
  ConnectorWriteOutcome,
  DeadLetterRows,
  DeletionTarget,
} from '../../src/store/port.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  outcomeOf,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type Outcome,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import { markGitHubEventSeen, markSlackEventSeen, writeEntry } from '../_helpers/root-forms.js';
import type { GitHubRouting, StoredCursors, SlackTeamRoute, SlackWorkspace } from '../../src/store/port/connectors.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { memorySide } from '../_helpers/memory-side.js';
import { sqliteConnectorEventsSide, type ConnectorEventsSide } from '../_helpers/connector-sides.js';
import { type ParkedLetter, type LoggedEvent } from '../../src/store/memory/tables.js';

oneRequestPerTest();

const NOW = '2026-03-01T12:00:05.000Z';
const ACTOR = 'connector:github';
const MESSAGE_REF = 'slack://T1/C1/1700.000001';
const COMMENT_REF = 'github://acme/demo/issue/1/comment/9';
const ONLY_B_REF = 'github://globex/site/issue/3/comment/4';
const REASON = 'source_deleted:github:issue_comment:d-1';

type Row = Pick<MemoryEntry, 'id' | 'tenantId' | 'kind'>;
type Archived = { readonly duplicate: boolean; readonly archived: number };
type Letter = DeadLetterRows['slack'] | DeadLetterRows['github'];
type Value =
  | ConnectorEventRecord
  | DeletionTarget
  | Archived
  | SlackTeamRoute
  | GitHubRouting
  | ConnectorWriteOutcome
  | Row[]
  | number
  | void
  | Letter
  | Letter[]
  | null
  | string
  | StoredCursors
  | SlackWorkspace
  | SlackWorkspace[]
  | boolean;
type Call = GroupCall<'connectorEvents', Value>;

interface Side {
  readonly outcomes: readonly Outcome<Value>[];
  readonly audit: readonly AuditEvent[];
  readonly events: readonly LoggedEvent[];
  readonly letters: readonly ParkedLetter[];
}

interface Seeded {
  readonly message: MemoryEntry;
  readonly messageB: MemoryEntry;
  readonly onlyB: MemoryEntry;
  readonly note: MemoryEntry;
  readonly commentB: MemoryEntry;
}

let fixture: TwoTenantFixture;
let home: string;
let seeded: Seeded;
let baseline: Side;
let copies = 0;

function seed(dir: string): Seeded {
  const rows = {
    message: createMemory('raw slack line about the outage', {
      tenantId: TENANT_A,
      kind: 'raw',
      artifactRef: MESSAGE_REF,
    }),
    messageB: createMemory('globex raw slack line under the same ref', {
      tenantId: TENANT_B,
      kind: 'raw',
      artifactRef: MESSAGE_REF,
    }),
    onlyB: createMemory('a raw comment only globex holds', {
      tenantId: TENANT_B,
      kind: 'raw',
      artifactRef: ONLY_B_REF,
    }),
    note: createMemory('a distilled note under the comment ref', { tenantId: TENANT_A, artifactRef: COMMENT_REF }),
    commentB: createMemory('globex raw comment under the comment ref', {
      tenantId: TENANT_B,
      kind: 'raw',
      artifactRef: COMMENT_REF,
    }),
  };
  for (const entry of Object.values(rows)) writeEntry(dir, entry, { actor: 'cli' });
  markSlackEventSeen(dir, 'Ev_empty', null);
  markSlackEventSeen(dir, 'Ev_stored', rows.message.id);
  markGitHubEventSeen(dir, { idempotencyKey: 'key-empty', deliveryId: 'd-seed', eventName: 'issues', memoryId: null });
  markGitHubEventSeen(dir, {
    idempotencyKey: 'key-stored',
    deliveryId: 'd-seed',
    eventName: 'issues',
    memoryId: rows.message.id,
  });
  return rows;
}

/** One workspace, one installation, and a repository two tenants registered, acme first. */
async function registerRoutes(root: string): Promise<void> {
  await sqliteStore(root).connectorEvents.registerSlackWorkspace('T_ACME', TENANT_A);
  const db = openHippoDb(root);
  try {
    db.prepare('INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)').run(
      '101',
      TENANT_A,
      '2026-01-01T00:00:00.000Z',
    );
    const repo = db.prepare('INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)');
    repo.run('acme/shared', TENANT_B, '2026-01-02T00:00:00.000Z');
    repo.run('acme/shared', TENANT_A, '2026-01-01T00:00:00.000Z');
    repo.run('globex/only', TENANT_B, '2026-01-03T00:00:00.000Z');
  } finally {
    closeHippoDb(db);
  }
}

function copyOfFixture(prepare: (root: string) => void): string {
  const root = join(home, `copy-${String(++copies)}`);
  cpSync(fixture.dir, root, { recursive: true });
  prepare(root);
  return root;
}

async function runSide(side: ConnectorEventsSide, calls: readonly Call[], guard: <T>(fn: () => T) => T): Promise<Side> {
  const group = side.store.connectorEvents;
  const outcomes: Outcome<Value>[] = [];
  for (const call of calls) outcomes.push(await outcomeOf(() => guard(() => call(group, side.store))));
  await side.store.close();
  return { outcomes, audit: side.auditRows(), events: side.events(), letters: side.letters() };
}

/** The other store's calls run with hippo.db blocked, so a method that falls back to it throws instead of matching by accident. */
async function conforms(calls: readonly Call[], prepare: (root: string) => void = () => undefined): Promise<Side> {
  const sqlite = await runSide(sqliteConnectorEventsSide(copyOfFixture(prepare)), calls, (fn) => fn());
  const memory = memorySide(copyOfFixture(prepare));
  const other = await runSide(memory, calls, (fn) => withSqliteBlocked(memory.store.kind, fn));
  expectSameOutcomes({ other, sqlite });
  return sqlite;
}

const slack = (eventId: string): ConnectorEvent => ({ connector: 'slack', eventId });
const github = (idempotencyKey: string, deliveryId = 'd-1') =>
  ({ connector: 'github', idempotencyKey, deliveryId, eventName: 'issue_comment' }) as const;
const record =
  (event: ConnectorEvent): Call =>
  (g) =>
    g.eventRecord(event);
const mark =
  (event: ConnectorEvent): Call =>
  (g) =>
    g.markEventSeen(event);
const target =
  (event: ConnectorEvent, artifactRef: string, tenantId: string): Call =>
  (g) =>
    g.deletionTarget({ event, artifactRef, tenantId });
const archive =
  (event: ReturnType<typeof github>, artifactRef: string): Call =>
  (g) =>
    g.archiveDeletedArtifact({ tenantId: TENANT_A, actor: ACTOR, artifactRef, reason: REASON, event });
const park =
  (letter: ConnectorDeadLetter): Call =>
  (g) =>
    g.parkDeadLetter(letter);
const writeRaw =
  (entry: MemoryEntry): Call =>
  (_g, store) =>
    store.connectorWrites.writeConnectorEntry({ entry, actor: ACTOR });
const readBack =
  (tenantId: string, ...ids: string[]): Call =>
  async (_g, store) =>
    (await store.entriesByIds(ids, tenantId)).map((e) => ({ id: e.id, tenantId: e.tenantId, kind: e.kind }));
const values = (side: Side): unknown[] => side.outcomes.map((o) => ('value' in o ? o.value : o));

/** The audit rows a run added, without the ids and times both sides already matched on. */
const added = (side: Side): Omit<AuditEvent, 'id' | 'ts'>[] =>
  side.audit.slice(baseline.audit.length).map(({ id: _id, ts, ...row }) => {
    expect(ts).toBe(NOW);
    return row;
  });
const isSeeded = (row: LoggedEvent): boolean =>
  baseline.events.some((b) => b.connector === row.connector && b.eventKey === row.eventKey);
/** The log rows a run added; the seeded rows must still read as they were seeded. */
function newEvents(side: Side): LoggedEvent[] {
  expect(side.events.filter(isSeeded)).toEqual(baseline.events);
  return side.events.filter((row) => !isSeeded(row));
}
const loggedRow = (event: ConnectorEvent, memoryId: string | null): LoggedEvent =>
  event.connector === 'slack'
    ? { connector: 'slack', eventKey: event.eventId, memoryId, deliveryId: null, eventName: null, loggedAt: NOW }
    : {
        connector: 'github',
        eventKey: event.idempotencyKey,
        memoryId,
        deliveryId: event.deliveryId,
        eventName: event.eventName,
        loggedAt: NOW,
      };

beforeAll(async () => {
  fixture = seedTwoTenants();
  home = mkdtempSync(join(tmpdir(), 'hippo-connector-events-'));
  seeded = seed(fixture.dir);
  baseline = await conforms([]);
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectorEvents.eventRecord', () => {
  it('answers unseen for a new key, the memory of a key logged with one and null for a key logged with none, one key space per connector', async () => {
    const { message } = seeded;
    const side = await conforms([
      record(slack('Ev_new')),
      record(slack('Ev_stored')),
      record(slack('Ev_empty')),
      record(github('key-new')),
      record(github('key-stored')),
      record(github('key-empty')),
      record(slack('key-stored')),
      record(github('Ev_stored')),
    ]);
    const stored = { seen: true, memoryId: message.id };
    const empty = { seen: true, memoryId: null };
    expect(values(side)).toEqual([
      { seen: false },
      stored,
      empty,
      { seen: false },
      stored,
      empty,
      { seen: false },
      { seen: false },
    ]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});

describe('ConnectorEvents.markEventSeen', () => {
  it('logs a new key once with no memory, and a key logged before keeps its row and the memory it names', async () => {
    const { message } = seeded;
    const side = await conforms([
      mark(slack('Ev_marked')),
      mark(slack('Ev_marked')),
      mark(github('key-marked', 'd-first')),
      mark(github('key-marked', 'd-second')),
      mark(slack('Ev_stored')),
      mark(github('key-stored', 'd-late')),
      record(slack('Ev_marked')),
      record(slack('Ev_stored')),
      record(github('key-stored')),
    ]);
    expect(values(side)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { seen: true, memoryId: null },
      { seen: true, memoryId: message.id },
      { seen: true, memoryId: message.id },
    ]);
    expect(newEvents(side)).toEqual([
      loggedRow(slack('Ev_marked'), null),
      loggedRow(github('key-marked', 'd-first'), null),
    ]);
    expect(added(side)).toEqual([]);
  });
});

describe('ConnectorEvents.deletionTarget', () => {
  it("answers the tenant's own raw row under the ref and never another tenant's, seen for an event logged before, and writes nothing", async () => {
    const { message, messageB } = seeded;
    const side = await conforms([
      target(slack('Ev_deleted'), MESSAGE_REF, TENANT_A),
      target(slack('Ev_deleted'), MESSAGE_REF, TENANT_B),
      target(slack('Ev_deleted'), ONLY_B_REF, TENANT_A),
      target(slack('Ev_deleted'), COMMENT_REF, TENANT_A),
      target(slack('Ev_deleted'), 'slack://T1/C1/never', TENANT_A),
      target(slack('Ev_empty'), MESSAGE_REF, TENANT_A),
      target(github('key-stored'), MESSAGE_REF, TENANT_A),
    ]);
    const none = { seen: false, memoryId: null };
    expect(values(side)).toEqual([
      { seen: false, memoryId: message.id },
      { seen: false, memoryId: messageB.id },
      none,
      none,
      none,
      { seen: true },
      { seen: true },
    ]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});

describe('ConnectorEvents.archiveDeletedArtifact', () => {
  const fresh = (content: string): MemoryEntry =>
    createMemory(content, { tenantId: TENANT_A, kind: 'raw', artifactRef: COMMENT_REF });
  const remembered = (e: MemoryEntry) => ({
    tenantId: TENANT_A,
    actor: ACTOR,
    op: 'remember',
    targetId: e.id,
    metadata: { kind: 'raw', scope: e.scope },
  });
  const archivedRow = (e: MemoryEntry) => ({
    tenantId: TENANT_A,
    actor: ACTOR,
    op: 'archive_raw',
    targetId: e.id,
    metadata: { reason: REASON },
  });

  it('archives every raw row the tenant holds under the ref and no other row, logs the event naming the first, and answers a redelivery duplicate', async () => {
    const { note, commentB } = seeded;
    const [first, edited] = [fresh('the comment as first posted'), fresh('the comment after its edit')];
    const side = await conforms([
      writeRaw(first),
      writeRaw(edited),
      archive(github('key-deleted'), COMMENT_REF),
      archive(github('key-deleted', 'd-again'), COMMENT_REF),
      readBack(TENANT_A, first.id, edited.id, note.id),
      readBack(TENANT_B, commentB.id),
    ]);
    expect(values(side)).toEqual([
      { outcome: 'written' },
      { outcome: 'written' },
      { duplicate: false, archived: 2 },
      { duplicate: true, archived: 0 },
      [{ id: note.id, tenantId: TENANT_A, kind: 'distilled' }],
      [{ id: commentB.id, tenantId: TENANT_B, kind: 'raw' }],
    ]);
    expect(newEvents(side)).toEqual([loggedRow(github('key-deleted'), first.id)]);
    expect(added(side)).toEqual([remembered(first), remembered(edited), archivedRow(first), archivedRow(edited)]);
  });

  it('with no raw row of the tenant under the ref it archives nothing and still logs the event, so a redelivery answers duplicate', async () => {
    const { onlyB } = seeded;
    const side = await conforms([
      archive(github('key-nothing'), ONLY_B_REF),
      archive(github('key-nothing', 'd-again'), ONLY_B_REF),
      readBack(TENANT_B, onlyB.id),
    ]);
    expect(values(side)).toEqual([
      { duplicate: false, archived: 0 },
      { duplicate: true, archived: 0 },
      [{ id: onlyB.id, tenantId: TENANT_B, kind: 'raw' }],
    ]);
    expect([newEvents(side), added(side)]).toEqual([[loggedRow(github('key-nothing'), null)], []]);
  });
});

describe('ConnectorEvents.slackTeamRoute and githubRouting', () => {
  const team =
    (teamId: string): Call =>
    (g) =>
      g.slackTeamRoute(teamId);
  const routing =
    (query: { installationId?: string | null; repoFullName?: string | null }): Call =>
    (g) =>
      g.githubRouting(query);
  const CALLS = [
    team('T_ACME'),
    team('T_OTHER'),
    routing({ installationId: '101' }),
    routing({ installationId: '999', repoFullName: 'acme/shared' }),
    routing({ repoFullName: 'acme/shared' }),
    routing({ repoFullName: 'globex/only' }),
    routing({ repoFullName: 'nobody/none' }),
    routing({}),
  ];

  it('answer the registered tenant, an installation ahead of a repository and the first tenant to register a repository, else the table sizes', async () => {
    const side = await conforms(CALLS, registerRoutes);
    const sized = (tenant: string | null) => ({ installations: 1, repositories: 3, tenant });
    expect(values(side)).toEqual([
      { tenantId: TENANT_A },
      { tenantId: null, workspaceCount: 1 },
      sized(TENANT_A),
      sized(null),
      sized(TENANT_A),
      sized(TENANT_B),
      sized(null),
      sized(null),
    ]);
  });

  it('with nothing registered answer no tenant and empty tables', async () => {
    const side = await conforms(CALLS);
    const empty = { installations: 0, repositories: 0, tenant: null };
    expect(values(side)).toEqual([
      { tenantId: null, workspaceCount: 0 },
      { tenantId: null, workspaceCount: 0 },
      empty,
      empty,
      empty,
      empty,
      empty,
      empty,
    ]);
  });
});

describe('ConnectorEvents.parkDeadLetter', () => {
  it("appends to the queue of the letter's connector and answers the row id, storing null for each column a letter leaves out", async () => {
    const common = {
      tenantId: TENANT_A,
      rawPayload: '{"half":',
      error: 'invalid JSON',
      bucket: 'parse_error',
      signature: null,
    } as const;
    const side = await conforms([
      park({ connector: 'slack', ...common, teamId: 'T_ACME', signature: 'v0=abc', slackTimestamp: '1700000000' }),
      park({
        connector: 'github',
        ...common,
        bucket: 'unroutable',
        eventName: 'issues',
        deliveryId: 'd-9',
        installationId: '999',
        repoFullName: 'nobody/none',
      }),
      park({ connector: 'slack', ...common, tenantId: '__unroutable__' }),
      park({ connector: 'github', ...common }),
    ]);
    expect(values(side)).toEqual([1, 1, 2, 2]);
    const row = {
      ...common,
      receivedAt: NOW,
      teamId: null,
      slackTimestamp: null,
      eventName: null,
      deliveryId: null,
      installationId: null,
      repoFullName: null,
      retryCount: 0,
      retriedAt: null,
    };
    expect(side.letters).toEqual([
      { ...row, connector: 'slack', id: 1, teamId: 'T_ACME', signature: 'v0=abc', slackTimestamp: '1700000000' },
      { ...row, connector: 'slack', id: 2, tenantId: '__unroutable__' },
      {
        ...row,
        connector: 'github',
        id: 1,
        bucket: 'unroutable',
        eventName: 'issues',
        deliveryId: 'd-9',
        installationId: '999',
        repoFullName: 'nobody/none',
      },
      { ...row, connector: 'github', id: 2 },
    ]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});

describe('ConnectorEvents dead-letter reads', () => {
  const common = { rawPayload: '{"half":', error: 'invalid JSON', bucket: 'parse_error', signature: null } as const;
  const LETTERS = [
    park({ connector: 'slack', ...common, tenantId: TENANT_A, teamId: 'T_ACME' }),
    park({ connector: 'slack', ...common, tenantId: TENANT_B }),
    park({ connector: 'github', ...common, tenantId: TENANT_A, eventName: 'issues' }),
    park({ connector: 'slack', ...common, tenantId: TENANT_A }),
  ];

  it("list one queue's rows of the tenant oldest first up to the limit, read one by id, and count a retry on the row named", async () => {
    const side = await conforms([
      ...LETTERS,
      (g) => g.markDeadLetterRetried('slack', TENANT_A, 1),
      (g) => g.markDeadLetterRetried('github', TENANT_A, 9),
      (g) => g.deadLetters('slack', TENANT_A, 10),
      (g) => g.deadLetters('slack', TENANT_A, 1),
      (g) => g.deadLetters('github', TENANT_B, 10),
      (g) => g.deadLetter('github', TENANT_A, 1),
      (g) => g.deadLetter('slack', TENANT_B, 2),
      (g) => g.deadLetter('slack', TENANT_A, 9),
    ]);
    // SAFETY: calls 6 to 10 are the three lists and two found rows, in that order.
    const [slackA, retried, , github, slackB] = values(side).slice(6) as [Letter[], Letter[], Letter[], Letter, Letter];
    expect(slackA.map((r) => [r.id, r.retryCount, r.retriedAt])).toEqual([
      [1, 1, NOW],
      [3, 0, null],
    ]);
    expect([retried.length, values(side)[8], values(side)[11]]).toEqual([1, [], null]);
    expect([github, slackB]).toMatchObject([
      { id: 1, tenantId: TENANT_A, eventName: 'issues', retryCount: 0 },
      { id: 2, tenantId: TENANT_B, teamId: null },
    ]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});

describe('ConnectorEvents backfill cursors', () => {
  it("keep each tenant's Slack channel cursor and GitHub high-water marks, and a seed fills only the marks not yet saved", async () => {
    const side = await conforms([
      (g) => g.slackCursor(TENANT_A, 'C1'),
      (g) => g.saveSlackCursor(TENANT_A, 'C1', '1700.1'),
      (g) => g.saveSlackCursor(TENANT_A, 'C1', '1700.2'),
      (g) => g.slackCursor(TENANT_A, 'C1'),
      (g) => g.slackCursor(TENANT_B, 'C1'),
      (g) => g.githubCursors(TENANT_A, 'acme/demo'),
      (g) => g.saveGitHubHwm(TENANT_A, 'acme/demo', 'issue_comments_hwm', '2026-02-01T00:00:00Z'),
      (g) => g.seedGitHubCursors(TENANT_A, 'acme/demo', '2026-01-01T00:00:00Z'),
      (g) => g.seedGitHubCursors(TENANT_A, 'acme/demo', '2025-01-01T00:00:00Z'),
      (g) => g.githubCursors(TENANT_A, 'acme/demo'),
      (g) => g.githubCursors(TENANT_B, 'acme/demo'),
    ]);
    const none = { issues: null, issueComments: null, prReviewComments: null };
    expect(values(side)).toEqual([
      null,
      undefined,
      undefined,
      '1700.2',
      null,
      none,
      undefined,
      undefined,
      undefined,
      {
        issues: '2026-01-01T00:00:00Z',
        issueComments: '2026-02-01T00:00:00Z',
        prReviewComments: '2026-01-01T00:00:00Z',
      },
      none,
    ]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});

describe('ConnectorEvents Slack workspace registry', () => {
  it('registers a team, moves it to another tenant on a second register, lists by team and removes it once', async () => {
    const side = await conforms(
      [
        (g) => g.registerSlackWorkspace('T_ZED', TENANT_B),
        (g) => g.registerSlackWorkspace('T_ACME', TENANT_B),
        (g) => g.slackWorkspaces(),
        (g) => g.slackTeamRoute('T_ACME'),
        (g) => g.removeSlackWorkspace('T_ZED'),
        (g) => g.removeSlackWorkspace('T_ZED'),
        (g) => g.slackWorkspaces(),
      ],
      registerRoutes,
    );
    const acme = { teamId: 'T_ACME', tenantId: TENANT_B, addedAt: NOW };
    expect(values(side)).toEqual([
      { teamId: 'T_ZED', tenantId: TENANT_B, addedAt: NOW },
      acme,
      [acme, { teamId: 'T_ZED', tenantId: TENANT_B, addedAt: NOW }],
      { tenantId: TENANT_B },
      true,
      false,
      [acme],
    ]);
  });
});

describe('ConnectorEvents delivery holds', () => {
  const claim =
    (connector: ConnectorEvent['connector'], key: string, nowMs: number): Call =>
    (g) =>
      g.claimDelivery({ connector, key, nowMs, ttlMs: 1000 });

  it('refuses a key while its hold lasts, frees it at expiry or on release, and keeps one key space per connector', async () => {
    const side = await conforms([
      claim('slack', 'sig-a', 0),
      claim('slack', 'sig-a', 999),
      claim('github', 'sig-a', 999),
      claim('slack', 'sig-a', 1000),
      (g) => g.releaseDelivery('slack', 'sig-a'),
      claim('slack', 'sig-a', 1001),
      (g) => g.releaseDelivery('slack', 'never-held'),
    ]);
    expect(values(side)).toEqual([true, false, true, true, undefined, true, undefined]);
    expect([newEvents(side), added(side)]).toEqual([[], []]);
  });
});
