// Each sleep event renders as the exact line the display text built before events existed.
import { describe, expect, it } from 'vitest';
import type { SleepEvent } from '../../src/api/sleep/events.js';
import { sleepEventLine } from '../../src/surface/render/sleep-events.js';

const rank = { rank: 2, totalNonPinned: 10, tenantId: 'acme', keepN: 3 };

const CASES: ReadonlyArray<[SleepEvent, string]> = [
  [
    { kind: 'dormant', id: 'm1', strength: 0.012345, threshold: 0.05 },
    '  💤 dormant m1 (strength 0.0123 < 0.05)',
  ],
  [
    { kind: 'removed', id: 'm1', strength: 0.01, threshold: 0.05 },
    '  🗑  removed m1 (strength 0.0100 < 0.05)',
  ],
  [
    { kind: 'rescued', id: 'm1', strength: 0.02, threshold: 0.05, rank },
    '  🛟 m1 (strength 0.0200 < 0.05) - rescued (rank 2/10 in tenant acme, top 3)',
  ],
  [
    { kind: 'rescued', id: 'm1', strength: 0.02, threshold: 0.05, rank: undefined },
    '  🛟 m1 (strength 0.0200 < 0.05) - rescued',
  ],
  [
    { kind: 'nonFiniteScores', ids: ['a', 'b'] },
    '  ⚠️ memory-value: skipped 2 entries with non-finite computed features (never rescued): a, b',
  ],
  [{ kind: 'passFailed', phase: 'dag', message: 'HTTP 500' }, '  ⚠️ dag: HTTP 500'],
  [
    { kind: 'dagSummaries', created: 2, factsLinked: 5 },
    '  🌳 DAG: 2 summaries created, 5 facts linked',
  ],
  [
    { kind: 'dagRebuild', rebuilt: 1, refused: 2, zeroChildSkipped: 3, failed: 4, cappedAt: 20 },
    '  🌳 DAG rebuild: 1 rebuilt, 2 refused, 3 zero-child-skipped, 4 failed, CAPPED@20',
  ],
  [
    { kind: 'dagRebuild', rebuilt: 1, refused: 0, zeroChildSkipped: 0, failed: 0, cappedAt: null },
    '  🌳 DAG rebuild: 1 rebuilt',
  ],
  [
    { kind: 'dagProfiles', profiles: 3, l2sLinked: 7 },
    '  🌲 DAG L3: 3 entity profiles, 7 L2s linked',
  ],
  [
    { kind: 'retiredText', id: 'a', successorId: 'b' },
    '  ✂️  a held a retired text, b holds the rest',
  ],
  [{ kind: 'retiredText', id: 'a', successorId: null }, '  ✂️  a held a retired text'],
  [
    { kind: 'merged', count: 3, preview: 'caching' },
    '  🔀 merged 3 episodic entries into semantic: "caching..."',
  ],
  [
    { kind: 'physics', particles: 3, shown: 3, stored: 3, avgVelocity: 0.123456 },
    '  ⚛️  physics: 3 particles, avg vel 0.1235',
  ],
  [
    { kind: 'physics', particles: 2, shown: 2, stored: 9, avgVelocity: 1 },
    '  ⚛️  physics: 2 particles (the 2 most recently recalled of 9), avg vel 1.0000',
  ],
  [
    { kind: 'phaseSkipped', phase: 'physics', message: 'boom' },
    '  ⚠️ physics simulation skipped: boom',
  ],
  [
    { kind: 'halfLifeRescaled', count: 1, from: 7, to: 365 },
    '  ⏳ moved 1 memories from the 7-day to the 365-day half-life',
  ],
  [
    { kind: 'halfLifeTyped', count: 2, from: 90, to: 365 },
    '  ⏳ moved 2 memories of decisions, incidents and other objects from the 90-day to the 365-day half-life',
  ],
  [
    { kind: 'notRemoved', id: 'm1' },
    '  ↩  m1 not removed: pinned or already gone before sleep saved',
  ],
  [
    { kind: 'dormantExpired', count: 1, retentionDays: 30 },
    '  ⌛ expired 1 dormant memory older than 30 days',
  ],
  [{ kind: 'conflictsDetected', count: 1 }, '  ⚠️ detected 1 memory conflict'],
  [
    { kind: 'rescueAuditFailed', failures: 2 },
    '  ⚠️ memory-value: 2 mv_rescue audit rows failed to write (the rescue itself still landed)',
  ],
  [
    { kind: 'rescueAuditUnavailable', rescues: 1 },
    '  ⚠️ memory-value: mv_rescue audit unavailable this cycle (1 rescue not audited)',
  ],
  [
    { kind: 'tracePromoted', id: 't1', sessionId: 's1', outcome: 'success' },
    '  🧬 promoted trace t1 from session s1 (success)',
  ],
  [{ kind: 'tracesPromoted', count: 1 }, '  🧬 promoted 1 trace from completed session'],
  [{ kind: 'tracesPromoted', count: 2 }, '  🧬 promoted 2 traces from completed sessions'],
  [
    { kind: 'sessionSkippedMixedScope', sessionId: 's1' },
    '  ⏭  skipped session s1: events span mixed scopes',
  ],
  [{ kind: 'replayed', ids: ['a', 'b'] }, '  💭 replayed 2 memories: a, b'],
  [
    { kind: 'graphSnapshotFailed', message: 'x' },
    'graph: dirty-tenant snapshot failed (skipped graph refresh): x',
  ],
  [{ kind: 'graphDrainFailed', message: 'x' }, 'graph: drain phase failed (skipped): x'],
  [
    { kind: 'graphStaleOpsSkipped', count: 2 },
    'graph: 2 stale op(s) skipped for a tenant; the next sleep redoes them',
  ],
  [
    { kind: 'graphExtractFailed', message: 'x' },
    'graph: extract failed for a dirty tenant (left pending): x',
  ],
];

describe('sleepEventLine', () => {
  it.each(CASES)('renders %j as the line it always printed', (event, line) => {
    expect(sleepEventLine(event, false)).toBe(line);
  });

  it('words the events that say what was done as "would" under a dry run', () => {
    expect(sleepEventLine({ kind: 'ftsResynced', indexedRows: 4, memories: 5 }, true)).toBe(
      '  🔎 would re-sync the full-text index (4 indexed rows for 5 memories)',
    );
    expect(sleepEventLine({ kind: 'ftsResynced', indexedRows: 4, memories: 5 }, false)).toBe(
      '  🔎 re-synced the full-text index (4 indexed rows for 5 memories)',
    );
    expect(sleepEventLine({ kind: 'halfLifeRescaled', count: 1, from: 7, to: 365 }, true)).toBe(
      '  ⏳ would move 1 memories from the 7-day to the 365-day half-life',
    );
    expect(sleepEventLine({ kind: 'dormantExpired', count: 2, retentionDays: 30 }, true)).toBe(
      '  ⌛ would expire 2 dormant memories older than 30 days',
    );
  });
});
