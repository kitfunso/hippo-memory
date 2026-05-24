/**
 * Snapshot tests for the CLI render helpers exported from src/cli.ts.
 *
 * Locks the byte-identical output of printContextMarkdown + renderSleepResult
 * across all render branches. Without these, refactors to the render layer
 * silently change agent-visible markdown (the format Claude Code etc. read
 * from `hippo context`). Drift caught at CI rather than by users.
 *
 * Determinism mechanism (per plan-eng-critic round-2 HIGH D):
 *   - vi.useFakeTimers({ now: '2026-05-23T20:00:00Z' }) in beforeEach so
 *     `new Date()` inside printContextMarkdown is stable across runs.
 *     resolveConfidence(e, now) drives the [verified]/[stale]/[inferred]
 *     tag — without fake timers, snapshots churn nondeterministically.
 *   - Fixed memory ids + ISO timestamps in the seed data (no ULID gen).
 *   - vi.useRealTimers() in afterEach restores the clock.
 *
 * Note: renderSleepResult output is unaffected by the v1.11.5 consolidate
 * audit emission — that metadata lives in audit_log, not in SleepResult.
 * The renderSleepResult snapshots exercise the existing render output only.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { printContextMarkdown, renderSleepResult } from '../src/cli.js';
import type { MemoryEntry } from '../src/memory.js';
import type { SleepResult } from '../src/api.js';

function makeMemory(overrides: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    id: overrides.id,
    content: overrides.content,
    created: overrides.created ?? '2026-05-22T10:00:00.000Z',
    last_retrieved: overrides.last_retrieved ?? '2026-05-22T10:00:00.000Z',
    retrieval_count: overrides.retrieval_count ?? 1,
    strength: overrides.strength ?? 0.85,
    half_life_days: overrides.half_life_days ?? 30,
    layer: overrides.layer ?? 'semantic',
    tags: overrides.tags ?? [],
    emotional_valence: overrides.emotional_valence ?? 'neutral',
    schema_fit: overrides.schema_fit ?? 0.7,
    source: overrides.source ?? 'test',
    outcome_score: overrides.outcome_score ?? null,
    outcome_positive: overrides.outcome_positive ?? 0,
    outcome_negative: overrides.outcome_negative ?? 0,
    conflicts_with: overrides.conflicts_with ?? [],
    pinned: overrides.pinned ?? false,
    confidence: overrides.confidence ?? 'verified',
    parents: overrides.parents ?? [],
    starred: overrides.starred ?? false,
    trace_outcome: overrides.trace_outcome ?? null,
    source_session_id: overrides.source_session_id ?? null,
    valid_from: overrides.valid_from ?? '2026-05-22T10:00:00.000Z',
    superseded_by: overrides.superseded_by ?? null,
    extracted_from: overrides.extracted_from ?? null,
    dag_level: overrides.dag_level ?? 0,
    dag_parent_id: overrides.dag_parent_id ?? null,
    kind: overrides.kind ?? 'distilled',
    scope: overrides.scope ?? null,
    owner: overrides.owner ?? null,
    artifact_ref: overrides.artifact_ref ?? null,
    tenantId: overrides.tenantId ?? 'default',
  };
}

function captureStdout(fn: () => void): string {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return logs.join('\n');
}

describe('printContextMarkdown snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-05-23T20:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // v1.11.5 follow-up (LOW #5 from independent-review-critic): a test that
  // throws before reaching afterEach would leak fake timers into the next
  // describe block. afterAll(useRealTimers) is defence-in-depth so the
  // file's timer state is always restored at suite end.
  afterAll(() => {
    vi.useRealTimers();
  });

  const memVerifiedSemantic = makeMemory({
    id: 'mem_test_001',
    content: 'always use real DB for tests',
    tags: ['path:skf_s', 'path:hippo'],
    confidence: 'verified',
    layer: 'semantic',
  });
  const memStaleEpisodic = makeMemory({
    id: 'mem_test_002',
    content: 'session 2025-08-12 debugging notes',
    created: '2025-08-12T10:00:00.000Z',
    tags: ['debug'],
    confidence: 'stale',
    layer: 'episodic',
    strength: 0.4,
  });
  const memInferredGlobal = makeMemory({
    id: 'mem_test_003',
    content: 'inferred fact from telemetry',
    tags: ['inferred'],
    confidence: 'inferred',
    strength: 0.6,
  });

  const items = [
    { entry: memVerifiedSemantic, score: 0.92, tokens: 12, isGlobal: false },
    { entry: memStaleEpisodic, score: 0.78, tokens: 18, isGlobal: false },
    { entry: memInferredGlobal, score: 0.65, tokens: 14, isGlobal: true },
  ];

  it('markdown default (framing=observe)', () => {
    const out = captureStdout(() => printContextMarkdown(items, 44, 'observe'));
    expect(out).toMatchSnapshot();
  });

  it('framing=suggest', () => {
    const out = captureStdout(() => printContextMarkdown(items, 44, 'suggest'));
    expect(out).toMatchSnapshot();
  });

  it('framing=assert', () => {
    const out = captureStdout(() => printContextMarkdown(items, 44, 'assert'));
    expect(out).toMatchSnapshot();
  });

  it('verified-only items (no stale/inferred tags)', () => {
    const verifiedItems = items.filter((i) => i.entry.confidence === 'verified');
    const out = captureStdout(() => printContextMarkdown(verifiedItems, 12, 'observe'));
    expect(out).toMatchSnapshot();
  });

  it('empty items', () => {
    const out = captureStdout(() => printContextMarkdown([], 0, 'observe'));
    expect(out).toMatchSnapshot();
  });

  it('global item only (isGlobal=true)', () => {
    const globalItems = [items[2]!];
    const out = captureStdout(() => printContextMarkdown(globalItems, 14, 'observe'));
    expect(out).toMatchSnapshot();
  });

  it('items with no tags', () => {
    const noTagItems = items.map((i) => ({
      ...i,
      entry: { ...i.entry, tags: [] },
    }));
    const out = captureStdout(() => printContextMarkdown(noTagItems, 44, 'observe'));
    expect(out).toMatchSnapshot();
  });

  it('single item with many tags', () => {
    const oneItem = [{
      entry: { ...memVerifiedSemantic, tags: ['a', 'b', 'c', 'd', 'e'] },
      score: 0.9,
      tokens: 20,
      isGlobal: false,
    }];
    const out = captureStdout(() => printContextMarkdown(oneItem, 20, 'observe'));
    expect(out).toMatchSnapshot();
  });
});

describe('renderSleepResult snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-05-23T20:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // Belt-and-braces (same rationale as printContextMarkdown block above).
  afterAll(() => {
    vi.useRealTimers();
  });

  it('dry run with no details', () => {
    const result: SleepResult = {
      active: 10,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: true,
      details: [],
    };
    const out = captureStdout(() => renderSleepResult(result));
    expect(out).toMatchSnapshot();
  });

  it('full run with dedup + audit + shared', () => {
    const result: SleepResult = {
      active: 50,
      removed: 3,
      mergedEpisodic: 5,
      newSemantic: 2,
      dryRun: false,
      details: ['Merged: 3 entries about caching strategy'],
      deduped: { removed: 4, semDups: 2, epiDups: 1, crossDups: 1 },
      audit: { errorsRemoved: 1, warningCount: 3 },
      shared: 2,
    };
    const out = captureStdout(() => renderSleepResult(result));
    expect(out).toMatchSnapshot();
  });

  it('minimal full run (no optional fields)', () => {
    const result: SleepResult = {
      active: 5,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
      details: [],
    };
    const out = captureStdout(() => renderSleepResult(result));
    expect(out).toMatchSnapshot();
  });

  it('audit warnings only (no errors)', () => {
    const result: SleepResult = {
      active: 20,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
      details: [],
      audit: { errorsRemoved: 0, warningCount: 5 },
    };
    const out = captureStdout(() => renderSleepResult(result));
    expect(out).toMatchSnapshot();
  });
});
