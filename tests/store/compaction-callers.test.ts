// The seams a server uses to save another machine's compaction: pre-compact, compact-resume and the store calls under them.
import { describe, expect, it, vi } from 'vitest';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { PRE_COMPACT_INSTRUCTION } from '../../src/surface/capture/compaction-record.js';
import {
  markSnapshotSaved,
  recordSummary,
  saveItems,
  startCompaction,
  type ItemContext,
} from '../../src/store/sqlite/compactions-record.js';
import { storeLesson } from '../../src/surface/capture/capture-error.js';
import { failureTarget } from '../_helpers/failure-target.js';
import { WORKING_STATE_CAPS } from '../../src/surface/capture/working-state.js';
import { compactResumeText } from '../../src/api/context-render.js';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import type { Context } from '../../src/api/types.js';
import { bindSessionOwner, compactResumeForCaller } from '../../src/server.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { sqliteCompactionHooks } from '../../src/store/sqlite/compaction-hooks.js';
import {
  ALICE,
  BOB,
  ITEMS,
  LESSON,
  META,
  PROJECT,
  STATE,
  TENANT,
  caught,
  count,
  failOn,
  holdout,
  noLog,
  owned,
  preCompact,
  recordRow,
  root,
  rowCounts,
  seed,
  snapshotRow,
  useCallerStore,
  whileLocked,
  withDb,
  writtenRows,
} from '../_helpers/compaction-callers.js';

useCallerStore();

describe('recordSummary for a caller', () => {
  it("takes the caller's project with no request id, on a store that may predate the column", () => {
    withDb((db) => {
      const rec = recordSummary(db, root, TENANT, {
        meta: META,
        text: { summary: '', items: [] },
        at: new Date(),
        caller: { originProject: 'acme/app' },
      });
      expect(rec.originProject).toBe('acme/app');
    });
  });
});

describe('saveItems for a caller', () => {
  it('keeps the post-compact actor and folder fallback when no caller is set', () => {
    withDb((db) => {
      const ctx: ItemContext = {
        tenantId: TENANT,
        recordId: null,
        sessionId: 's2',
        originProject: 'acme/app',
        cwd: null,
        items: [ITEMS[1]],
      };
      expect(saveItems(db, { hippoRoot: root }, ctx, noLog, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
      expect(writtenRows(db, 'compaction:s2')).toEqual([
        { content: ITEMS[1], origin_project: null, actor: 'post-compact' },
      ]);
    });
  });
});

describe('storeLesson for a caller', () => {
  const other = { actor: 'bob@acme', originProject: 'acme/web', origins: ['acme/web'] };

  it('counts a user-global lesson as a repeat in every project', async () => {
    seed(LESSON, '', ['error', 'auto-captured']);
    expect(
      sqliteSyncStore(handlesOf(root)).lessonWrites.contentsWithTag(TENANT, 'auto-captured', ['acme/web']),
    ).toEqual([LESSON]);
    expect(await storeLesson(failureTarget(root, TENANT), LESSON, other)).toBe('duplicate');
  });
});

describe('snapshot_saved under a tenant the environment does not name', () => {
  it('marks the record through both the handle and the root', () => {
    withDb((db) => {
      const a = startCompaction(db, TENANT, { ...META, originProject: 'acme/app' });
      const b = startCompaction(db, TENANT, { ...META, sessionId: 's3', originProject: 'acme/app' });
      markSnapshotSaved(db, TENANT, a);
      sqliteCompactionHooks(handlesOf(root).on).markSnapshotSaved(TENANT, b);
      expect([recordRow(db, a)?.snapshot_saved, recordRow(db, b)?.snapshot_saved]).toEqual([1, 1]);
    });
  });
});

describe('preCompactForCaller', () => {
  it("saves the owner's snapshot and returns the instruction", async () => {
    const bobs = saveActiveTaskSnapshot(
      root,
      TENANT,
      { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' },
      BOB,
    );
    expect(await preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    const mine = loadActiveTaskSnapshot(root, TENANT, ALICE);
    expect(mine).toMatchObject({ ...STATE, source: 'pre-compact', session_id: 'sA' });
    withDb((db) =>
      expect(snapshotRow(db, mine?.id ?? 0)).toMatchObject({ owner_subject: 'alice', origin_project: 'acme/app' }),
    );
    // The save superseded only Alice's rows: Bob's own row is still his active one.
    expect(loadActiveTaskSnapshot(root, TENANT, BOB)?.id).toBe(bobs.id);
  });

  it("keeps the owner's earlier field for the same session when a sent field is empty", async () => {
    saveActiveTaskSnapshot(
      root,
      TENANT,
      { task: 'Earlier task', summary: 'old', next_step: 'Earlier step', session_id: 'sA' },
      ALICE,
    );
    await preCompact(owned('alice'), { task: '', summary: 'New summary', next_step: '' });
    expect(loadActiveTaskSnapshot(root, TENANT, ALICE)).toMatchObject({
      task: 'Earlier task',
      summary: 'New summary',
      next_step: 'Earlier step',
    });
  });

  it("holdout gives '' and writes no snapshot", async () => {
    holdout();
    expect(await preCompact(owned('alice'))).toEqual({ stdout: '' });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('an over-cap field names the field', async () => {
    const summary = 'x'.repeat(WORKING_STATE_CAPS.summary + 1);
    const err = await caught(() => preCompact(owned('alice'), { ...STATE, summary }));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({
      status: 400,
      message: `working state summary: at most ${WORKING_STATE_CAPS.summary} characters`,
    });
    expect(await preCompact(owned('alice'), { ...STATE, summary: summary.slice(1) })).toEqual({
      stdout: PRE_COMPACT_INSTRUCTION,
    });
  });

  it('cuts each field back to its cap after the scrub, the summary keeping its newest turns', async () => {
    // a@b.co masks to [email], one longer, so a field sent at its cap runs one over after the scrub.
    const atCap = (cap: number, tail: string): string =>
      `Mail a@b.co first. ${'Then run the build. '.repeat(120)}`.slice(0, cap - tail.length) + tail;
    await preCompact(owned('alice'), {
      task: atCap(WORKING_STATE_CAPS.task, 'T'),
      summary: atCap(WORKING_STATE_CAPS.summary, 'NEWEST'),
      next_step: atCap(WORKING_STATE_CAPS.next_step, 'N'),
    });
    const saved = loadActiveTaskSnapshot(root, TENANT, ALICE);
    expect(saved?.task).toHaveLength(WORKING_STATE_CAPS.task);
    expect(saved?.task.startsWith('Mail [email] first.')).toBe(true);
    expect(saved?.next_step).toHaveLength(WORKING_STATE_CAPS.next_step);
    expect(saved?.summary.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.summary);
    expect(saved?.summary.endsWith('NEWEST')).toBe(true);
  });

  it('a snapshot failure still returns the instruction', async () => {
    failOn('task_snapshots', 'INSERT', 'snapshot boom');
    expect(await preCompact(owned('alice'))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    withDb((db) => {
      expect(count(db, 'task_snapshots')).toBe(0);
      expect(count(db, 'compactions', 'tenant_id = ? AND snapshot_saved = 0', TENANT)).toBe(1);
    });
  });

  it('a busy store at startCompaction still returns the instruction (F8)', async () => {
    await bindSessionOwner(owned('alice'), 'sA');
    expect(await whileLocked(() => preCompact(owned('alice')))).toEqual({ stdout: PRE_COMPACT_INSTRUCTION });
    expect(rowCounts()).toMatchObject({ compactions: 0, task_snapshots: 0 });
  });

  it('snapshot_saved = 1 on the ctx.tenantId record, whatever the environment names (F9)', async () => {
    vi.stubEnv('HIPPO_TENANT', 'env-tenant');
    await preCompact(owned('alice'));
    withDb((db) => {
      expect(
        count(
          db,
          'compactions',
          `tenant_id = ? AND snapshot_saved = 1 AND origin_project = 'acme/app' AND cwd IS NULL`,
          TENANT,
        ),
      ).toBe(1);
      expect(count(db, 'compactions', 'tenant_id = ?', 'env-tenant')).toBe(0);
    });
  });
});

describe('compactResumeForCaller', () => {
  const resume = (ctx: Context, source = 'compact') =>
    compactResumeForCaller(ctx, { sessionId: 'sA', project: PROJECT, source });

  it("source not compact gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    expect(await resume(owned('alice'), 'startup')).toEqual({ stdout: '' });
    expect((await resume(owned('alice'))).stdout).toContain(STATE.task);
  });

  it("holdout gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    holdout();
    expect(await resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("another session's snapshot gives ''", async () => {
    saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sOld' }, ALICE);
    expect(await resume(owned('alice'))).toEqual({ stdout: '' });
  });

  it("renders the owner's snapshot and books one compact_resume row", async () => {
    const mine = saveActiveTaskSnapshot(root, TENANT, { ...STATE, session_id: 'sA' }, ALICE);
    saveActiveTaskSnapshot(root, TENANT, { task: 'Bob task', summary: 'b', next_step: 'b', session_id: 'sB' }, BOB);
    const { stdout } = await resume(owned('alice'));
    expect(stdout).toBe(compactResumeText(mine, []));
    expect(stdout).not.toContain('Bob task');
    withDb((db) =>
      expect(
        count(
          db,
          'token_ledger',
          `tenant_id = ? AND session_id = 'sA' AND surface = 'compact_resume' AND event = 'inject'`,
          TENANT,
        ),
      ).toBe(1),
    );
  });
});
