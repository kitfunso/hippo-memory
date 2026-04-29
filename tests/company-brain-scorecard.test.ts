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
} from '../src/store.js';
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
  const snapshot = loadActiveTaskSnapshot(hippoRoot);
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

    saveActiveTaskSnapshot(tmpDir, {
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

    saveActiveTaskSnapshot(tmpDir, {
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
