// The seams a server uses to end a session and to keep two owners and two request ids apart.
import { describe, expect, it } from 'vitest';
import { BadRequestError, ConflictError } from '../../src/base/errors/api-errors.js';
import type { Context } from '../../src/api/types.js';
import {
  bindSessionOwner,
  captureFailureForCaller,
  compactResumeForCaller,
  saveCompactionItemsForCaller,
  sessionEndHandoffForCaller,
} from '../../src/server.js';
import { saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import {
  ALICE,
  BOB,
  ITEMS,
  PROJECT,
  STATE,
  TENANT,
  caught,
  count,
  failOn,
  failure,
  failureRows,
  handoffRows,
  owned,
  postCompact,
  preCompact,
  root,
  rowCounts,
  sessionEnd,
  snapshotRow,
  useCallerStore,
  withDb,
} from '../_helpers/compaction-callers.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useCallerStore();

describe('sessionEndHandoffForCaller', () => {
  it("writes the owner's handoff and closes only the owner's snapshot", async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // Bob's row names the same session id, so only the key keeps the close off it.
    const bobs = saveActiveTaskSnapshot(
      root,
      TENANT,
      { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sA' },
      BOB,
    );
    expect(await sessionEnd(owned('alice'))).toEqual({ handoffWritten: true, snapshotsClosed: 1 });
    withDb((db) => {
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
      expect(snapshotRow(db, bobs.id)?.status).toBe('active');
      expect(handoffRows(db)).toEqual([
        { session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' },
      ]);
    });
  });

  it('writes the handoff from the working state when the owner has no snapshot for the session', async () => {
    const req = { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null };
    expect(await sessionEndHandoffForCaller(owned('alice'), req)).toEqual({ handoffWritten: true, snapshotsClosed: 0 });
    expect(await sessionEndHandoffForCaller(owned('alice'), req)).toEqual({
      handoffWritten: false,
      snapshotsClosed: 0,
    });
    withDb((db) =>
      expect(handoffRows(db)).toEqual([
        { session_id: 'sA', task_id: STATE.task, owner_subject: 'alice', origin_project: 'acme/app' },
      ]),
    );
  });

  it('retry after a failed close writes no second handoff', async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    // An earlier save time, so the handoff is strictly newer than the snapshot it covers.
    withDb((db) =>
      db
        .prepare(`UPDATE task_snapshots SET updated_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), mine.id),
    );
    const undo = failOn('task_snapshots', 'UPDATE', 'close boom');
    await expect(sessionEnd(owned('alice'))).rejects.toThrow('close boom');
    undo();
    expect(await sessionEnd(owned('alice'))).toEqual({ handoffWritten: false, snapshotsClosed: 1 });
    withDb((db) => {
      expect(handoffRows(db)).toHaveLength(1);
      expect(snapshotRow(db, mine.id)?.status).toBe('session-ended');
    });
  });

  it('refuses a git ref that is not a commit id, naming the field', async () => {
    const evidence = { gitRef: 'main', dirtyTree: null, testStatus: null };
    const err = await caught(() =>
      sessionEndHandoffForCaller(owned('alice'), { sessionId: 'sA', project: PROJECT, workingState: null, evidence }),
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/^evidence gitRef:/) });
  });
});

describe('a second owner on the same session', () => {
  const calls: Array<[string, (ctx: Context) => object]> = [
    ['pre-compact', (ctx) => preCompact(ctx)],
    ['compact-resume', (ctx) => compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source: 'compact' })],
    ['post-compact', (ctx) => postCompact(ctx)],
    ['capture-error', (ctx) => captureFailureForCaller(ctx, failure())],
    [
      'session end',
      (ctx) =>
        sessionEndHandoffForCaller(ctx, { sessionId: 'sA', project: PROJECT, workingState: STATE, evidence: null }),
    ],
  ];

  it.each(calls)('%s: a second owner on the same session gets a 409 ConflictError', async (_name, call) => {
    await bindSessionOwner(owned('alice'), 'sA');
    const err = await caught(() => call(owned('bob')));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ status: 409 });
    expect(rowCounts()).toEqual({
      compactions: 0,
      task_snapshots: 0,
      session_handoffs: 0,
      failure_log: 0,
      memories: 0,
    });
    // The session's own owner still gets through.
    expect(await caught(() => call(owned('alice')))).toBeNull();
  });
});

describe('a request id another session sent', () => {
  const senders: Array<[string, string, string]> = [
    ['another session of the same owner', 'alice', 'sA2'],
    ['another owner', 'bob', 'sB'],
  ];
  const items = (owner: string, sessionId: string, list: readonly string[] = ITEMS) =>
    saveCompactionItemsForCaller(owned(owner), {
      sessionId,
      project: PROJECT,
      trigger: 'auto',
      items: list,
      requestId: 'cmp-1',
    });

  it('capture-error: the same id with a different body from the same session gets the first outcome and writes nothing', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    const other = failure({
      tool: 'Grep',
      text: 'Grep: no matches found',
      skip: 'skipped-routine',
      rule: 'search-tool',
    });
    expect(await captureFailureForCaller(owned('alice'), other)).toEqual({ outcome: 'stored' });
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 1 });
  });

  it.each(senders)(
    'capture-error: the same id from %s is a 409 and leaves the first row alone',
    async (_who, owner, sessionId) => {
      // A failed first store leaves a row a retry settles, which a foreign id would otherwise rewrite.
      const undo = failOn('memories', 'INSERT', 'store boom');
      await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
      undo();
      const err = await caught(() => captureFailureForCaller(owned(owner), failure({ sessionId })));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ status: 409, message: 'request id belongs to another session' });
      withDb((db) =>
        expect(failureRows(db)).toEqual([expect.objectContaining({ outcome: 'store-failed', owner_subject: 'alice' })]),
      );
      expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 0 });
      expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    },
  );

  it('post-compact: the same id with different items from the same session gets the first count and writes none of them', async () => {
    expect(await items('alice', 'sA')).toEqual({ written: 2 });
    expect(
      await items('alice', 'sA', ['The staging deploy needs the VPN up first or the health check times out.']),
    ).toEqual({ written: 2 });
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 2 });
  });

  it.each(senders)(
    'post-compact: the same id from %s is a 409 and never finishes the first record',
    async (_who, owner, sessionId) => {
      // Items that failed leave the record summarized, which a foreign id would otherwise finish under its own session.
      const undo = failOn('memories', 'INSERT', 'items boom');
      await expect(items('alice', 'sA')).rejects.toThrow('items boom');
      undo();
      const err = await caught(() => items(owner, sessionId));
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).toMatchObject({ status: 409, message: 'request id belongs to another session' });
      withDb((db) => expect(count(db, 'compactions', `status = 'summarised' AND session_id = 'sA'`)).toBe(1));
      expect(rowCounts()).toMatchObject({ compactions: 1, memories: 0 });
      expect(await items('alice', 'sA')).toEqual({ written: 2 });
    },
  );
});
