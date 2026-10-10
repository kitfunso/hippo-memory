import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleRecall } from '../src/cli/recall.js';
import { resetSessionRings } from '../src/api/recall-record.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-recall-cont-'));
  hippoDir = path.join(tmpDir, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmpDir, 'global'));
  resetSessionRings('cli');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** `hippo recall <query> [--continuity] [--json]`, run in this process against the temp store. */
async function runHippo(args: string[]): Promise<{ stdout: string; status: number }> {
  const [, query, ...rest] = args;
  const flags = Object.fromEntries(rest.map((f) => [f.replace(/^--/, ''), true]));
  return runInProcess(() => handleRecall({ hippoRoot: hippoDir, tenantId: 'default', args: [query], flags }));
}

function seedContinuity(): void {
  saveActiveTaskSnapshot(hippoDir, 'default', {
    task: 'Wire continuity into recall',
    summary: 'Plan reviewed twice. Implementation underway.',
    next_step: 'Land Task 4 CLI flag.',
    session_id: 'sess-recall-cont',
    source: 'test',
  });
  saveSessionHandoff(hippoDir, 'default', {
    version: 1,
    sessionId: 'sess-recall-cont',
    summary: 'Mid-task handoff.',
    nextAction: 'Resume on Task 4 step 2.',
    artifacts: ['src/cli.ts'],
  });
  appendSessionEvent(hippoDir, 'default', {
    session_id: 'sess-recall-cont',
    event_type: 'note',
    content: 'A trail event from the continuity test.',
    source: 'test',
  });
}

describe('hippo recall --continuity', () => {
  it('JSON: returns continuity alongside memories', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'deploys', '--continuity', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.continuity).toBeDefined();
    expect(parsed.continuity.activeSnapshot.task).toBe('Wire continuity into recall');
    expect(parsed.continuity.sessionHandoff.nextAction).toBe('Resume on Task 4 step 2.');
    expect(parsed.continuity.recentSessionEvents).toHaveLength(1);
    expect(parsed.continuityTokens).toBeGreaterThan(0);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
  });

  it('text: prints snapshot/handoff/trail headings above the memory list', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('another deploy memo', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'deploy', '--continuity']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Task Snapshot');
    expect(r.stdout).toContain('Session Handoff');
    expect(r.stdout).toContain('Recent Session');
    // Snapshot heading comes BEFORE the "Found N memories" line.
    expect(r.stdout.indexOf('Active Task Snapshot')).toBeLessThan(
      r.stdout.indexOf('Found'),
    );
  });

  it('does not include continuity when flag is absent (hot path)', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('hot path memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'hot', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.continuity).toBeUndefined();
    expect(parsed.continuityTokens).toBeUndefined();
  });

  // codex round 2 P1: zero-result regression must surface continuity.
  it('zero-result JSON: continuity still present when no memories match', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'totallyabsent_xyzzy', '--continuity', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.continuity).toBeDefined();
    expect(parsed.continuity.activeSnapshot.task).toBe('Wire continuity into recall');
  });

  it('zero-result text: prints continuity instead of bare "No memories found"', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'totallyabsent_xyzzy', '--continuity']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active Task Snapshot');
    expect(r.stdout).toContain('Session Handoff');
    expect(r.stdout).toContain('(no memories matched');
    expect(r.stdout).not.toContain('No memories found for:');
  });

  it('zero-result without --continuity still prints "No memories found"', async () => {
    initStore(hippoDir);
    writeEntry(hippoDir, createMemory('nothing relevant', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    seedContinuity();

    const r = await runHippo(['recall', 'totallyabsent_xyzzy']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No memories found for:');
    expect(r.stdout).not.toContain('Active Task Snapshot');
  });
});
