import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { retrieve } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { saveActiveTaskSnapshot, appendSessionEvent, saveSessionHandoff } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, apiCtx } = sessionPerTest();

let tmpDir: string;
beforeEach(() => {
  tmpDir = makeRoot('recall-cont', { init: false });
});

describe('api.recall continuity flag', () => {
  it('defaults to no continuity block (hot path)', async () => {
    initTestStore(tmpDir);
    writeEntry(tmpDir, createMemory('test memory about widgets', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));

    const result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), { query: 'widgets' });
    expect(result.continuity).toBeUndefined();
    expect(result.continuityTokens).toBeUndefined();
  });

  it('includes snapshot, handoff, and recent events when includeContinuity=true', async () => {
    initTestStore(tmpDir);
    writeEntry(tmpDir, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Ship the recall continuity slice',
      summary: 'Plan reviewed, implementation in progress.',
      nextStep: 'Run tests, then commit.',
      sessionId: 'sess-1',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-1',
      summary: 'Mid-implementation handoff.',
      nextAction: 'Pick up at Task 3.',
      artifacts: ['src/api/index.ts'],
    });
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: 'sess-1',
      eventType: 'note',
      content: 'A trail event we want to surface.',
      source: 'test',
    });

    const result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'deploys',
      window: { includeContinuity: true },
    });
    expect(result.continuity!.activeSnapshot?.task).toBe('Ship the recall continuity slice');
    expect(result.continuity!.sessionHandoff?.nextAction).toBe('Pick up at Task 3.');
    expect(result.continuity!.recentSessionEvents).toHaveLength(1);
    expect(result.continuityTokens).toBe(50);
  });

  it('returns continuity block with nulls/empty when no continuity state exists', async () => {
    initTestStore(tmpDir);
    writeEntry(tmpDir, createMemory('lonely memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));

    const result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'lonely',
      window: { includeContinuity: true },
    });
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
    expect(result.continuityTokens).toBe(0);
  });

  it('does not surface another tenant continuity', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A secret',
      summary: 'A',
      nextStep: 'A',
      sessionId: 'sess-a',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'sess-a',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });
    await appendSessionEvent(tmpDir, 'tenantA', {
      sessionId: 'sess-a',
      eventType: 'note',
      content: 'A trail',
      source: 'test',
    });

    const result = await retrieve(apiCtx(tmpDir, 'tenantB', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
  });

  it('does not surface a handoff from a session with no active snapshot', async () => {
    initTestStore(tmpDir);
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-completed-yesterday',
      summary: 'Yesterday I shipped a thing.',
      nextAction: 'Should not resurface today.',
      artifacts: [],
    });

    const result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
  });

  it('default-deny scope rule excludes private-scope continuity for no-scope callers', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'private task',
      summary: 'private',
      nextStep: 'private',
      sessionId: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const noScopeResult = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(noScopeResult.continuity!.activeSnapshot).toBeNull();

    const scopedResult = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
      filter: { scope: 'slack:private:Csecret' },
    });
    expect(scopedResult.continuity!.activeSnapshot?.task).toBe('private task');
  });

  it('readLatestHandoff returns scope on the row, default-deny rejects private', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Public anchor',
      summary: 'public',
      nextStep: 'public',
      sessionId: 'sess-private-handoff',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-private-handoff',
      summary: 'PRIVATE handoff content',
      nextAction: 'secret next',
      artifacts: [],
      scope: 'slack:private:Csecret',
    });

    const noScopeResult = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(noScopeResult.continuity!.activeSnapshot?.task).toBe('Public anchor');
    expect(noScopeResult.continuity!.sessionHandoff).toBeNull();

    const scopedResult = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
      filter: { scope: 'slack:private:Csecret' },
    });
    expect(scopedResult.continuity!.sessionHandoff?.summary).toBe('PRIVATE handoff content');
  });

  it('explicit scope is exact-match, not allow-all (cross-scope leak guard)', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'C1 task',
      summary: 'C1',
      nextStep: 'C1',
      sessionId: 'sess-c1',
      source: 'test',
      scope: 'slack:private:C1',
    });

    const c2Result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
      filter: { scope: 'slack:private:C2' },
    });
    expect(c2Result.continuity!.activeSnapshot).toBeNull();

    const c1Result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
      filter: { scope: 'slack:private:C1' },
    });
    expect(c1Result.continuity!.activeSnapshot?.task).toBe('C1 task');
  });

  it('reports continuityTokens with Math.ceil(len/4) accounting', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'aaaa',
      summary: 'bbbb',
      nextStep: 'cccc',
      sessionId: 'sess-1',
      source: 'test',
    });

    const result = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(result.continuityTokens).toBe(3);
  });

  it('counts outcome, targetRuntime and cardId toward continuityTokens', async () => {
    initTestStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'aaaa',
      summary: 'bbbb',
      nextStep: 'cccc',
      sessionId: 'sess-1',
      source: 'test',
    });
    const before = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });

    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-1',
      summary: 'handoff',
      artifacts: [],
      outcome: 'success',
      targetRuntime: 'node',
      cardId: 'CARD-1',
    });
    const after = await retrieve(apiCtx(tmpDir, 'default', { subject: 'test', role: 'admin' }), {
      query: 'anything',
      window: { includeContinuity: true },
    });
    expect(after.continuityTokens!).toBeGreaterThan(before.continuityTokens!);
  });
});
