import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  listSessionEvents,
  writeEntry,
  loadAllEntries,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { buildProvenanceCoverage } from '../src/provenance-coverage.js';
import { buildCorrectionLatency } from '../src/correction-latency.js';
import { estimateTokens } from '../src/search.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-company-brain-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ResumeScorecard {
  coverage: number;
  distilledTokens: number;
  rawTranscriptTokens: number;
  text: string;
  signals: Record<string, boolean>;
}

function buildResumeScorecard(hippoRoot: string, sessionId: string): ResumeScorecard {
  const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
  const handoff = loadLatestHandoff(hippoRoot, sessionId);
  const events = listSessionEvents(hippoRoot, { session_id: sessionId, limit: 12 });

  const signals = {
    task: Boolean(snapshot?.task?.trim()),
    snapshotSummary: Boolean(snapshot?.summary?.trim()),
    nextStep: Boolean(snapshot?.next_step?.trim()),
    handoffSummary: Boolean(handoff?.summary?.trim()),
    nextAction: Boolean(handoff?.nextAction?.trim()),
    artifacts: Boolean(handoff?.artifacts?.length),
    eventTrail: events.length > 0,
  };

  const covered = Object.values(signals).filter(Boolean).length;
  const coverage = covered / Object.keys(signals).length;

  const eventTrail = events
    .slice(-1)
    .map((event) => {
      const preview = event.content.split(/\s+/).slice(0, 4).join(' ');
      return `${event.event_type}: ${preview}`;
    });

  const parts: string[] = [];

  if (snapshot) {
    parts.push(`Task: ${snapshot.task}`);
    parts.push(`Summary: ${snapshot.summary}`);
    parts.push(`Next: ${snapshot.next_step}`);
  }

  if (handoff) {
    parts.push(`Handoff: ${handoff.summary}`);
    if (handoff.nextAction) {
      parts.push(`Action: ${handoff.nextAction}`);
    }
    if ((handoff.artifacts ?? []).length > 0) {
      parts.push(`Artifacts: ${(handoff.artifacts ?? []).join(', ')}`);
    }
  }

  if (eventTrail.length > 0) {
    parts.push(`Recent: ${eventTrail.join(' | ')}`);
  }

  const text = parts.join('\n');
  const rawTranscript = events.map((event) => event.content).join('\n');

  return {
    coverage,
    distilledTokens: estimateTokens(text),
    rawTranscriptTokens: estimateTokens(rawTranscript),
    text,
    signals,
  };
}

function appendVerboseTrail(hippoRoot: string, sessionId: string): void {
  const steps = [
    'Read the production deploy notes, compared the current branch state, and traced the failing path through the session continuity code while checking whether the latest snapshot should replace the stale branch summary.',
    'Confirmed that the current task is to ship the measurement-first plan, identified the open blocker around handoff visibility, and noted that the raw event trail is too noisy to replay verbatim for a fresh agent.',
    'Checked the review notes, compared the older session handoff against the active branch work, and wrote down that the next action should be opening the PR only after the continuity scorecard is green.',
    'Verified that the important artefacts are the measurement doc, the roadmap note, and the scorecard test, while the surrounding chat text is mostly orientation overhead that should not be replayed in full.',
    'Summarised the blocker as missing handoff visibility in the default resume path and recorded that the current branch is ready for review once the scorecard confirms complete resume coverage.',
    'Captured that the likely follow-up implementation slice is continuity-first context assembly rather than broad ingestion or graph work because the repo can measure continuity now.',
  ];

  steps.forEach((content, index) => {
    appendSessionEvent(hippoRoot, {
      session_id: sessionId,
      event_type: index === 0 ? 'session_start' : 'note',
      content,
      source: 'test',
    });
  });
}

describe('Company Brain continuity scorecard scaffold', () => {
  it('shows full resume coverage only after continuity objects are present', () => {
    initStore(tmpDir);
    const sessionId = 'sess-company-brain';

    appendVerboseTrail(tmpDir, sessionId);

    const baseline = buildResumeScorecard(tmpDir, sessionId);
    expect(baseline.coverage).toBeLessThan(1);
    expect(baseline.signals.eventTrail).toBe(true);
    expect(baseline.signals.task).toBe(false);

    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Ship the Company Brain measurement tranche',
      summary: 'Docs are updated and the continuity scorecard is the only code scaffold in scope.',
      next_step: 'Run the scorecard test, then verify the baseline red tests stayed unchanged.',
      session_id: sessionId,
      source: 'test',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId,
      summary: 'Measurement plan is ready for review.',
      nextAction: 'Open the PR after verifying the continuity scorecard and build output.',
      artifacts: ['docs/plans/2026-04-28-company-brain-measurement.md', 'tests/company-brain-scorecard.test.ts'],
    });

    const featureOn = buildResumeScorecard(tmpDir, sessionId);
    expect(featureOn.coverage).toBeGreaterThan(baseline.coverage);
    expect(featureOn.coverage).toBe(1);
    expect(featureOn.rawTranscriptTokens).toBeGreaterThan(0);
    expect(featureOn.distilledTokens).toBeLessThan(featureOn.rawTranscriptTokens * 0.45);
  });

  it('uses the matching session handoff instead of a stale one from another session', () => {
    initStore(tmpDir);
    const currentSession = 'sess-current';

    appendVerboseTrail(tmpDir, currentSession);

    saveActiveTaskSnapshot(tmpDir, 'default', {
      task: 'Resume the current branch cleanly',
      summary: 'Current session is about the continuity-first slice.',
      next_step: 'Use the current-session handoff, not the stale one.',
      session_id: currentSession,
      source: 'test',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-old',
      summary: 'Old branch handoff',
      nextAction: 'Ship the stale branch',
      artifacts: ['src/stale.ts'],
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: currentSession,
      summary: 'Current branch handoff',
      nextAction: 'Open the PR for the current branch',
      artifacts: ['src/current.ts'],
    });

    const scorecard = buildResumeScorecard(tmpDir, currentSession);
    expect(scorecard.text).toContain('Open the PR for the current branch');
    expect(scorecard.text).not.toContain('Ship the stale branch');
  });
});

describe('Company Brain provenance coverage scorecard', () => {
  it('drops below 1.0 when any raw receipt is missing owner or artifact_ref', () => {
    initStore(tmpDir);

    writeEntry(
      tmpDir,
      createMemory('slack message from keith about the brand voice', {
        kind: 'raw',
        owner: 'user:keith',
        artifact_ref: 'slack://team/eng/1714500000.001',
        source: 'slack',
      }),
    );
    writeEntry(
      tmpDir,
      createMemory('github PR body for the envelope migration', {
        kind: 'raw',
        owner: 'agent:hippo',
        artifact_ref: 'gh://hippo/hippo-memory/pull/42',
        source: 'github',
      }),
    );
    writeEntry(
      tmpDir,
      createMemory('legacy distilled memory predating the envelope work', {
        kind: 'distilled',
        source: 'cli',
      }),
    );
    writeEntry(
      tmpDir,
      createMemory('raw row from a misconfigured connector with no envelope', {
        kind: 'raw',
        source: 'broken-connector',
      }),
    );

    const entries = loadAllEntries(tmpDir);
    const coverage = buildProvenanceCoverage(entries);

    expect(coverage.rawTotal).toBe(3);
    expect(coverage.rawWithEnvelope).toBe(2);
    expect(coverage.coverage).toBeCloseTo(2 / 3, 5);
    expect(coverage.coverage).toBeLessThan(1);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0].missing.sort()).toEqual(['artifact_ref', 'owner']);

    const distilledIds = entries.filter((e) => e.kind === 'distilled').map((e) => e.id);
    const distilledLeak = coverage.gaps.some((g) => distilledIds.includes(g.id));
    expect(distilledLeak).toBe(false);
  });

  it('reaches the 100% gate once every raw receipt carries owner and artifact_ref', () => {
    initStore(tmpDir);

    writeEntry(
      tmpDir,
      createMemory('slack message ingest with full envelope', {
        kind: 'raw',
        owner: 'user:keith',
        artifact_ref: 'slack://team/eng/1714500001.002',
        source: 'slack',
      }),
    );
    writeEntry(
      tmpDir,
      createMemory('github PR body with full envelope', {
        kind: 'raw',
        owner: 'agent:hippo',
        artifact_ref: 'gh://hippo/hippo-memory/pull/43',
        source: 'github',
      }),
    );

    const coverage = buildProvenanceCoverage(loadAllEntries(tmpDir));

    expect(coverage.rawTotal).toBe(2);
    expect(coverage.coverage).toBe(1);
    expect(coverage.gaps).toHaveLength(0);
  });
});

describe('Company Brain correction-latency scorecard', () => {
  it('returns an empty report when no supersessions exist', () => {
    const a = createMemory('belief: pricing tier is 100', {});
    const report = buildCorrectionLatency([a]);
    expect(report.count).toBe(0);
    expect(report.manualCount).toBe(0);
    expect(report.extractionCount).toBe(0);
    expect(report.p50Ms).toBeNull();
    expect(report.p95Ms).toBeNull();
    expect(report.maxMs).toBeNull();
    expect(report.pairs).toEqual([]);
  });

  it('flags direct supersedes as manual with zero measurable latency', () => {
    const oldEntry = createMemory('belief: tier is 100', {});
    (oldEntry as { created: string }).created = '2026-04-01T00:00:00.000Z';
    const newEntry = createMemory('belief: tier is 120', {});
    (newEntry as { created: string }).created = '2026-04-02T00:00:00.000Z';
    (oldEntry as { superseded_by: string | null }).superseded_by = newEntry.id;

    const report = buildCorrectionLatency([oldEntry, newEntry]);

    expect(report.count).toBe(1);
    expect(report.manualCount).toBe(1);
    expect(report.extractionCount).toBe(0);
    expect(report.p50Ms).toBeNull();
    expect(report.pairs[0].via).toBe('manual');
    expect(report.pairs[0].latencyMs).toBe(0);
  });

  it('measures extraction-driven latency from receipt to supersession', () => {
    const rawReceipt = createMemory('slack: pricing tier moved to 120 today', {
      kind: 'raw',
      owner: 'user:keith',
      artifact_ref: 'slack://team/eng/1714600100.001',
    });
    (rawReceipt as { created: string }).created = '2026-04-01T10:00:00.000Z';

    const oldFact = createMemory('belief: tier is 100', {});
    (oldFact as { created: string }).created = '2026-03-15T00:00:00.000Z';

    const newFact = createMemory('belief: tier is 120', {
      extracted_from: rawReceipt.id,
    });
    (newFact as { created: string }).created = '2026-04-01T10:30:00.000Z';
    (oldFact as { superseded_by: string | null }).superseded_by = newFact.id;

    const report = buildCorrectionLatency([rawReceipt, oldFact, newFact]);

    expect(report.count).toBe(1);
    expect(report.extractionCount).toBe(1);
    expect(report.manualCount).toBe(0);
    expect(report.pairs[0].via).toBe('extraction');
    expect(report.pairs[0].latencyMs).toBe(30 * 60 * 1000);
    expect(report.p50Ms).toBe(30 * 60 * 1000);
    expect(report.maxMs).toBe(30 * 60 * 1000);
  });

  it('skips pairs with malformed timestamps so NaN never reaches percentiles', () => {
    const oldEntry = createMemory('belief: tier is 100', {});
    (oldEntry as { created: string }).created = '2026-04-01T00:00:00.000Z';
    const newEntry = createMemory('belief: tier is 120', {});
    (newEntry as { created: string }).created = 'not-a-date';
    (oldEntry as { superseded_by: string | null }).superseded_by = newEntry.id;

    const report = buildCorrectionLatency([oldEntry, newEntry]);
    expect(report.count).toBe(0);
    expect(report.p50Ms).toBeNull();
  });

  it('handles dangling superseded_by pointers without throwing', () => {
    const oldEntry = createMemory('belief points at a missing successor', {});
    (oldEntry as { superseded_by: string | null }).superseded_by = 'mem-does-not-exist';

    const report = buildCorrectionLatency([oldEntry]);
    expect(report.count).toBe(0);
    expect(report.pairs).toEqual([]);
  });

  it('computes p50/p95/max across multiple extraction-driven corrections', () => {
    const entries = [];
    const baseRaw = '2026-04-01T00:00:00.000Z';
    const lagsMin = [5, 10, 15, 20, 25, 30, 60, 120, 300, 600];

    lagsMin.forEach((lagMin, i) => {
      const raw = createMemory(`raw receipt ${i}`, {
        kind: 'raw',
        owner: 'user:keith',
        artifact_ref: `slack://team/eng/${i}`,
      });
      (raw as { created: string }).created = baseRaw;

      const oldFact = createMemory(`belief ${i} v1`, {});
      (oldFact as { created: string }).created = '2026-03-01T00:00:00.000Z';

      const newFact = createMemory(`belief ${i} v2`, { extracted_from: raw.id });
      (newFact as { created: string }).created = new Date(
        new Date(baseRaw).getTime() + lagMin * 60 * 1000,
      ).toISOString();
      (oldFact as { superseded_by: string | null }).superseded_by = newFact.id;

      entries.push(raw, oldFact, newFact);
    });

    const report = buildCorrectionLatency(entries);

    expect(report.extractionCount).toBe(10);
    expect(report.maxMs).toBe(600 * 60 * 1000);
    expect(report.p50Ms).toBe(((25 + 30) / 2) * 60 * 1000);
    expect(report.p95Ms).toBeGreaterThan(300 * 60 * 1000);
    expect(report.p95Ms).toBeLessThanOrEqual(600 * 60 * 1000);
  });
});
