// The seams a server uses to save another machine's compaction items and failures: the post-compact and capture-error calls.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStoreBusy } from '../../src/store/port.js';
import { loadConfig } from '../../src/host/config-file.js';
import { captureToolFailure } from '../../src/surface/capture/capture-error.js';
import { failureTarget } from '../_helpers/failure-target.js';
import { failureHash, failureReport } from '../../src/surface/capture/failure-reading.js';
import { COMPACTION_ITEM_MAX_CHARS } from '../../src/base/util/compaction-items.js';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import type { Context } from '../../src/api/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { bindSessionOwner, captureFailureForCaller, saveCompactionItemsForCaller } from '../../src/server.js';
import {
  ITEMS,
  LESSON,
  PROJECT,
  SHARED_REACH,
  TENANT,
  caught,
  count,
  failOn,
  failure,
  failureRows,
  holdout,
  owned,
  postCompact,
  preCompact,
  root,
  rowCounts,
  seed,
  useCallerStore,
  whileLocked,
  withDb,
  writtenRows,
} from '../_helpers/compaction-callers.js';

useCallerStore();

describe('saveCompactionItemsForCaller', () => {
  it('writes with ownerOrSubject as actor and the project as origin', async () => {
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    const unowned: Context = {
      store: sqliteStore(root),
      config: loadConfig(root),
      tenantId: TENANT,
      actor: { subject: 'api_key:hk_carol', role: 'member' },
      reach: SHARED_REACH,
    };
    await saveCompactionItemsForCaller(unowned, {
      sessionId: 'sC',
      project: { name: 'acme/web', legacyName: 'web' },
      trigger: 'auto',
      items: [ITEMS[0]],
      requestId: 'cmp-c',
    });
    withDb((db) => {
      expect(writtenRows(db, 'compaction:sA')).toEqual([
        { content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' },
        { content: ITEMS[0], origin_project: 'acme/app', actor: 'alice' },
      ]);
      expect(writtenRows(db, 'compaction:sC')).toEqual([
        { content: ITEMS[0], origin_project: 'acme/web', actor: 'api_key:hk_carol' },
      ]);
      expect(
        count(
          db,
          'compactions',
          `session_id = 'sA' AND status = 'done' AND request_id = 'cmp-1' AND origin_project = 'acme/app'`,
        ),
      ).toBe(1);
    });
  });

  it("held rows read from the caller's project", async () => {
    seed(ITEMS[0], 'app');
    seed(ITEMS[1], 'other/project');
    expect(await postCompact(owned('alice'))).toEqual({ written: 1 });
    withDb((db) =>
      expect(writtenRows(db, 'compaction:sA')).toEqual([
        { content: ITEMS[1], origin_project: 'acme/app', actor: 'alice' },
      ]),
    );
  });

  it('holdout writes nothing', async () => {
    holdout();
    expect(await postCompact(owned('alice'))).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it('a repeat request_id writes nothing and returns the earlier result', async () => {
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    expect(rowCounts()).toMatchObject({ compactions: 1, memories: 2 });
    // A new request id is a new compaction; its items are already held.
    expect(await postCompact(owned('alice'), 'cmp-2')).toEqual({ written: 0 });
    expect(rowCounts()).toMatchObject({ compactions: 2, memories: 2 });
  });

  it('a retry reuses the summarised record', async () => {
    const undo = failOn('memories', 'INSERT', 'items boom');
    await expect(postCompact(owned('alice'))).rejects.toThrow('items boom');
    undo();
    expect(await postCompact(owned('alice'))).toEqual({ written: 2 });
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `status = 'done' AND items_written = 2 AND request_id = 'cmp-1'`)).toBe(1);
    });
  });

  it('cuts an item back to its cap after the scrub, so one a mask runs past the cap still becomes a row', async () => {
    const item = `Mail a@b.co before the deploy. ${ITEMS.join(' ')} ${ITEMS.join(' ')} ${ITEMS.join(' ')}`.slice(
      0,
      COMPACTION_ITEM_MAX_CHARS,
    );
    expect(item).toHaveLength(COMPACTION_ITEM_MAX_CHARS);
    const req = { sessionId: 'sA', project: PROJECT, trigger: 'auto', items: [item], requestId: 'cmp-1' };
    expect(await saveCompactionItemsForCaller(owned('alice'), req)).toEqual({ written: 1 });
    const stored = item.replace('a@b.co', '[email]').slice(0, COMPACTION_ITEM_MAX_CHARS);
    withDb((db) => expect(writtenRows(db, 'compaction:sA').map((r) => r.content)).toEqual([stored]));
  });

  it('refuses an item past its cap before the scrub, naming the field, before it binds the session', async () => {
    const req = {
      sessionId: 'sA',
      project: PROJECT,
      trigger: 'auto',
      items: ['x'.repeat(COMPACTION_ITEM_MAX_CHARS + 1)],
      requestId: 'cmp-1',
    };
    const err = await caught(() => saveCompactionItemsForCaller(owned('alice'), req));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(/^items:/) });
    withDb((db) => expect(count(db, 'session_owners')).toBe(0));
  });

  it('busy throws, no spool file', async () => {
    await bindSessionOwner(owned('alice'), 'sA');
    const err = await whileLocked(() => caught(() => postCompact(owned('alice'))));
    expect(isStoreBusy(err)).toBe(true);
    expect(fs.existsSync(path.join(root, 'compactions-spool'))).toBe(false);
    expect(rowCounts()).toMatchObject({ compactions: 0, memories: 0 });
  });

  it("summarises pre-compact's record and stamps the request id on it", async () => {
    await preCompact(owned('alice'));
    await postCompact(owned('alice'));
    withDb((db) => {
      expect(count(db, 'compactions')).toBe(1);
      expect(count(db, 'compactions', `request_id = 'cmp-1' AND status = 'done' AND snapshot_saved = 1`)).toBe(1);
    });
  });
});

describe('captureFailureForCaller', () => {
  it('lesson carries owner as actor and project origin, and the log row both', async () => {
    expect(await captureFailureForCaller(owned('alice'), failure())).toEqual({ outcome: 'stored' });
    withDb((db) => {
      expect(writtenRows(db, 'tool-failure')).toEqual([
        { content: LESSON, origin_project: 'acme/app', actor: 'alice' },
      ]);
      expect(failureRows(db)).toEqual([
        {
          outcome: 'stored',
          owner_subject: 'alice',
          origin_project: 'acme/app',
          request_id: 'fail-1',
          sig_hash: failureHash(LESSON),
          detail_hash: null,
        },
      ]);
    });
  });

  it('repeat check is per project', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect((await captureFailureForCaller(owned('alice'), failure({ requestId: 'fail-2' }))).outcome).toBe('duplicate');
    const web = { name: 'acme/web', legacyName: 'web' };
    expect(
      (await captureFailureForCaller(owned('bob'), failure({ sessionId: 'sB', project: web, requestId: 'fail-3' })))
        .outcome,
    ).toBe('stored');
  });

  it('a repeat request_id writes nothing and returns the earlier result', async () => {
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    expect(rowCounts()).toMatchObject({ failure_log: 1, memories: 1 });
  });

  it('a retry after a failed store stores the lesson and settles its log row', async () => {
    const undo = failOn('memories', 'INSERT', 'store boom');
    await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['store-failed']));
    undo();
    expect((await captureFailureForCaller(owned('alice'), failure())).outcome).toBe('stored');
    withDb((db) => expect(failureRows(db).map((r) => r.outcome)).toEqual(['stored']));
  });

  it('detail_hash equals what logFailure stores for the same payload', async () => {
    const payload = {
      session_id: 'local-s',
      tool_name: 'Bash',
      error: 'npm run build failed: src/a.ts(12,3): error TS2304: Cannot find name foo',
      tool_input: { command: 'cd /repo && npm run build' },
    };
    await captureToolFailure(failureTarget(root, TENANT), payload);
    const report = failureReport(payload);
    await captureFailureForCaller(
      owned('alice'),
      failure({
        tool: report.tool,
        text: report.text,
        skip: report.skip,
        rule: report.rule,
        detailHash: report.detail_hash,
      }),
    );
    withDb((db) => {
      const [local, caller] = failureRows(db);
      expect(local.detail_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(caller).toMatchObject({
        sig_hash: local.sig_hash,
        detail_hash: local.detail_hash,
        owner_subject: 'alice',
      });
    });
  });

  it('scrubs a sent text again and cuts it to 200 after the scrub, so a mask that runs longer still stores', async () => {
    const text = `Bash: mail to a@b.co failed. ${'Retry the deploy. '.repeat(10)}`.slice(0, 200);
    expect(text).toHaveLength(200);
    expect((await captureFailureForCaller(owned('alice'), failure({ text }))).outcome).toBe('stored');
    withDb((db) => {
      const [row] = writtenRows(db, 'tool-failure');
      expect(row?.content).toBe(`Bash: mail to [email] failed. ${'Retry the deploy. '.repeat(10)}`.slice(0, 200));
      expect(failureRows(db)[0]?.sig_hash).toBe(failureHash(row?.content ?? ''));
    });
  });

  it('cuts the scrubbed text on a code point, never inside a surrogate pair', async () => {
    // 200 sent; the mask adds one, so the emoji's halves land at 199 and 200 of the scrubbed text.
    const filler = 'Retry the deploy. '.repeat(10).slice(0, 169);
    const text = `Bash: mail to a@b.co failed. ${filler}\u{1F600}`;
    expect(text).toHaveLength(200);
    expect((await captureFailureForCaller(owned('alice'), failure({ text }))).outcome).toBe('stored');
    withDb((db) => expect(writtenRows(db, 'tool-failure')[0]?.content).toBe(`Bash: mail to [email] failed. ${filler}`));
  });

  it('log error never masks a store error', async () => {
    failOn('memories', 'INSERT', 'store boom');
    failOn('failure_log', 'INSERT', 'log boom');
    await expect(captureFailureForCaller(owned('alice'), failure())).rejects.toThrow('store boom');
  });

  it('logs a routine skip with its rule and stores no lesson', async () => {
    const req = failure({ tool: 'Grep', text: 'Grep: no matches found', skip: 'skipped-routine', rule: 'search-tool' });
    expect(await captureFailureForCaller(owned('alice'), req)).toEqual({ outcome: 'skipped-routine' });
    withDb((db) => {
      expect(count(db, 'memories')).toBe(0);
      expect(count(db, 'failure_log', `outcome = 'skipped-routine' AND skip_rule = 'search-tool'`)).toBe(1);
    });
  });

  it.each([
    ['a routine skip with no rule', failure({ skip: 'skipped-routine', rule: null }), 'rule'],
    ['a rule on a lesson', failure({ rule: 'declined' }), 'rule'],
    ['a detail hash that is not 16 hex', failure({ detailHash: 'xyz' }), 'detail hash'],
    ['a blank request id', failure({ requestId: '' }), 'request id'],
    ['text past 200 characters', failure({ text: 'x'.repeat(201) }), 'text'],
    ['a lesson with no text', failure({ text: null }), 'text'],
  ])('refuses %s, naming the field, before it binds the session', async (_what, req, field) => {
    const err = await caught(() => captureFailureForCaller(owned('alice'), req));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: expect.stringMatching(new RegExp(`^${field}:`)) });
    withDb((db) => expect(count(db, 'session_owners')).toBe(0));
  });
});
