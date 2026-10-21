// W1 handoff envelope: the ambient handoff pop-off, scope filtering on the continuity reads, and the carry-forward fixes.
import { describe, it, expect, beforeEach } from 'vitest';
import { contextGet, adminActor } from '../../src/api/index.js';
import { apiCtx, cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import {
  closeTaskSnapshotsForSession,
  loadLatestHandoff,
  stampHandoffOutcome,
  writeSessionEndHandoff,
  saveActiveTaskSnapshot,
  appendSessionEvent,
  saveSessionHandoff,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

let root: string;

oneRequestPerTest();
beforeEach(() => {
  root = makeRoot('w1-handoff', { init: false });
});

describe('IC-SMDP fixture, ambient handoff pop-off', () => {
  it('surfaces the newest unfinished handoff, then the next one after each stamp', async () => {
    initTestStore(root);
    const ctx = apiCtx(root, 'default', adminActor('test'));

    for (let i = 1; i <= 10; i++) {
      const sessionId = `sess-${i}`;
      saveActiveTaskSnapshot(root, 'default', {
        task: `T_${i}`,
        summary: `summary ${i}`,
        nextStep: `next ${i}`,
        sessionId: sessionId,
      });
      writeSessionEndHandoff(root, {
        tenantId: 'default',
        sessionId,
        evidence: { gitRef: `ref${i}`, dirtyTree: false, testStatus: 'pass' },
      });
      closeTaskSnapshotsForSession(root, 'default', sessionId);
    }

    const fresh = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh-session' });
    expect(fresh.sessionHandoff?.taskId).toBe('T_10');

    expect(stampHandoffOutcome(root, 'default', 'sess-10', 'success')).toBe(1);
    const afterOne = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh-session' });
    expect(afterOne.sessionHandoff?.taskId).toBe('T_9');

    for (let i = 1; i <= 9; i++) {
      stampHandoffOutcome(root, 'default', `sess-${i}`, 'success');
    }
    const afterAll = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh-session' });
    expect(afterAll.sessionHandoff).toBeUndefined();
  });
});

describe('scope filtering on the continuity read paths', () => {
  it('8a: ambient fallback does not surface a private-scoped unfinished handoff', async () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-priv',
      summary: 'private',
      artifacts: [],
      scope: 'slack:private:C1',
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh' });
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8b: ambient fallback does not surface an unknown:legacy scoped unfinished handoff', async () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-legacy',
      summary: 'legacy',
      artifacts: [],
      scope: 'unknown:legacy',
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh' });
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8c: ambient fallback surfaces a null-scoped unfinished handoff', async () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-pub',
      summary: 'public',
      artifacts: [],
      scope: null,
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'fresh' });
    expect(result.sessionHandoff?.sessionId).toBe('sess-pub');
  });

  it('8d: session-keyed path does not inject a private-scoped active snapshot or handoff', async () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-priv-active',
      scope: 'slack:private:C1',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-priv-active',
      summary: 'private handoff',
      artifacts: [],
      scope: 'slack:private:C1',
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'sess-priv-active' });
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.sessionHandoff).toBeUndefined();
  });

  it("8e: session-keyed path does not fall through to another session's unfinished handoff", async () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-a',
      scope: 'slack:private:C1',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-b',
      summary: 'unrelated handoff',
      artifacts: [],
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'sess-a' });
    // pre-fix: activeSnapshot (scope-filtered) was null, so keying on activeSnapshot?.session_id fell through to the ambient unfinishedOnly lookup and surfaced sess-b's handoff.
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8f: recentEvents admits each event on its own scope, keyed on the raw snapshot', async () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-mix',
      scope: 'proj:private:x',
    });
    appendSessionEvent(root, 'default', {
      sessionId: 'sess-mix',
      eventType: 'note',
      content: 'public event',
    });
    appendSessionEvent(root, 'default', {
      sessionId: 'sess-mix',
      eventType: 'note',
      content: 'private event',
      scope: 'proj:private:x',
    });
    const ctx = apiCtx(root, 'default', adminActor('test'));
    const result = await contextGet(ctx, { currentProject: cwdProject(), currentSessionId: 'sess-mix' });
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.recentEvents).toHaveLength(1);
    expect(result.recentEvents?.[0].content).toBe('public event');
  });
});

describe('fix 1: unfinishedOnly selects the newest revision per session', () => {
  it('does not resurrect an older null-outcome revision after the newest is stamped', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-s', summary: 'older', artifacts: [] });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-s', summary: 'newer', artifacts: [] });
    expect(stampHandoffOutcome(root, 'default', 'sess-s', 'success')).toBe(1);

    // Session S is fully done: ambient unfinishedOnly must not fall back to its older null row.
    expect(loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true })).toBeNull();

    // A genuinely unfinished session still surfaces.
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-t', summary: 'still open', artifacts: [] });
    const unfinished = loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true });
    expect(unfinished!.sessionId).toBe('sess-t');
  });
});

describe('fix 2: scopeFilter default-deny admits scope before LIMIT 1', () => {
  it('skips a newer private-scoped row to return an older public one', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-pub',
      summary: 'public',
      artifacts: [],
      scope: null,
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-priv',
      summary: 'private',
      artifacts: [],
      scope: 'proj:private:x',
    });

    const admitted = loadLatestHandoff(root, 'default', undefined, {
      unfinishedOnly: true,
      scopeFilter: 'default-deny',
    });
    expect(admitted!.sessionId).toBe('sess-pub');
  });

  it('skips an unknown:legacy scoped row', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-pub2',
      summary: 'public',
      artifacts: [],
      scope: null,
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-legacy',
      summary: 'legacy',
      artifacts: [],
      scope: 'unknown:legacy',
    });

    const admitted = loadLatestHandoff(root, 'default', undefined, {
      unfinishedOnly: true,
      scopeFilter: 'default-deny',
    });
    expect(admitted!.sessionId).toBe('sess-pub2');
  });
});

describe('fix 3: writeSessionEndHandoff carries forward same-task envelope metadata', () => {
  it('same task keeps constraints/cardId/targetRuntime/artifacts/repoRoot; a different task does not inherit them', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-carry',
      taskId: 'T',
      summary: 'explicit handoff',
      artifacts: ['file.ts'],
      constraints: ['no schema break'],
      cardId: 'card-9',
      targetRuntime: 'codex',
      repoRoot: '/repo/root',
    });
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T',
      summary: 'snapshot summary',
      nextStep: 'next',
      sessionId: 'sess-carry',
    });
    const refreshed = writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-carry', evidence: null });
    expect(refreshed!.constraints).toEqual(['no schema break']);
    expect(refreshed!.cardId).toBe('card-9');
    expect(refreshed!.targetRuntime).toBe('codex');
    expect(refreshed!.artifacts).toEqual(['file.ts']);
    expect(refreshed!.repoRoot).toBe('/repo/root');

    // Different task on refresh: nothing carries forward.
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-diff',
      taskId: 'T-old',
      summary: 'explicit handoff',
      artifacts: ['old.ts'],
      constraints: ['old constraint'],
      cardId: 'card-old',
      targetRuntime: 'old-runtime',
      repoRoot: '/old/root',
    });
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T-new',
      summary: 'snapshot summary',
      nextStep: 'next',
      sessionId: 'sess-diff',
    });
    const notCarried = writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-diff', evidence: null });
    expect(notCarried!.constraints).toEqual([]);
    expect(notCarried!.cardId).toBeNull();
    expect(notCarried!.targetRuntime).toBeNull();
    expect(notCarried!.artifacts).toEqual([]);
    expect(notCarried!.repoRoot).toBeUndefined();
  });

  it('same task but scope mismatch does not carry a private handoff into an unscoped envelope', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-scope-mismatch',
      taskId: 'T',
      summary: 'private handoff',
      artifacts: ['secret.ts'],
      constraints: ['no schema break'],
      cardId: 'card-9',
      targetRuntime: 'codex',
      repoRoot: '/repo/root',
      scope: 'proj:private:x',
    });
    // Unscoped snapshot for the same task/session, as pre-compact and `snapshot save` produce.
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T',
      summary: 'snapshot summary',
      nextStep: 'next',
      sessionId: 'sess-scope-mismatch',
    });
    const handoff = writeSessionEndHandoff(root, {
      tenantId: 'default',
      sessionId: 'sess-scope-mismatch',
      evidence: null,
    });
    expect(handoff!.artifacts).toEqual([]);
    expect(handoff!.constraints).toEqual([]);
    expect(handoff!.cardId).toBeNull();
    expect(handoff!.targetRuntime).toBeNull();
    expect(handoff!.repoRoot).toBeUndefined();
  });
});
