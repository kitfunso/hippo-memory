import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
  writeEntry,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { recall } from '../src/api.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-recall-cont-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('api.recall continuity flag', () => {
  it('defaults to no continuity block (hot path)', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('test memory about widgets', {}));

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'widgets' },
    );
    expect(result.continuity).toBeUndefined();
    expect(result.continuityTokens).toBeUndefined();
  });

  it('includes snapshot, handoff, and recent events when includeContinuity=true', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('memory about deploys', {}));
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Ship the recall continuity slice',
      summary: 'Plan reviewed, implementation in progress.',
      next_step: 'Run tests, then commit.',
      session_id: 'sess-1',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-1',
      summary: 'Mid-implementation handoff.',
      nextAction: 'Pick up at Task 3.',
      artifacts: ['src/api.ts'],
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess-1',
      event_type: 'note',
      content: 'A trail event we want to surface.',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'deploys', includeContinuity: true },
    );
    expect(result.continuity).toBeDefined();
    expect(result.continuity!.activeSnapshot?.task).toBe('Ship the recall continuity slice');
    expect(result.continuity!.sessionHandoff?.nextAction).toBe('Pick up at Task 3.');
    expect(result.continuity!.recentSessionEvents).toHaveLength(1);
    expect(result.continuityTokens).toBeGreaterThan(0);
  });

  it('returns continuity block with nulls/empty when no continuity state exists', () => {
    initStore(tmpDir);
    writeEntry(tmpDir, createMemory('lonely memory', {}));

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'lonely', includeContinuity: true },
    );
    expect(result.continuity).toBeDefined();
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
    expect(result.continuityTokens).toBe(0);
  });

  it('does not surface another tenant continuity', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'tenantA', {
      task: 'A secret',
      summary: 'A',
      next_step: 'A',
      session_id: 'sess-a',
      source: 'test',
    });
    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'sess-a',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });
    appendSessionEvent(tmpDir, 'tenantA', {
      session_id: 'sess-a',
      event_type: 'note',
      content: 'A trail',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'tenantB', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
    expect(result.continuity!.recentSessionEvents).toEqual([]);
  });

  // codex P2: do not resurrect a stale handoff when the active snapshot is gone.
  it('does not surface a handoff from a session with no active snapshot', () => {
    initStore(tmpDir);
    saveSessionHandoff(tmpDir, 'default', {
      version: 1,
      sessionId: 'sess-completed-yesterday',
      summary: 'Yesterday I shipped a thing.',
      nextAction: 'Should not resurface today.',
      artifacts: [],
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    expect(result.continuity!.activeSnapshot).toBeNull();
    expect(result.continuity!.sessionHandoff).toBeNull();
  });

  it('reports continuityTokens with Math.ceil(len/4) accounting', () => {
    initStore(tmpDir);
    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'aaaa',
      summary: 'bbbb',
      next_step: 'cccc',
      session_id: 'sess-1',
      source: 'test',
    });

    const result = recall(
      { hippoRoot: tmpDir, tenantId: 'default', actor: 'test' },
      { query: 'anything', includeContinuity: true },
    );
    // 4 + 4 + 4 chars at Math.ceil(len/4) = 1+1+1 = 3
    expect(result.continuityTokens).toBe(3);
  });
});
