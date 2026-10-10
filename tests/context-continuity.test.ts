import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleContext } from '../src/cli/context.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { initStore } from '../src/store/open.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-context-continuity-'));
  hippoDir = path.join(tmpDir, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmpDir, 'global'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** `hippo context` run in this process against the temp store; a non-zero exit fails the test as a spawn would. */
async function runHippo(flags: Record<string, string>): Promise<string> {
  const r = await runInProcess(() => withHookStdin(undefined, () => handleContext({ hippoRoot: hippoDir, tenantId: 'default', args: [], flags })));
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

function seedContinuityState(): void {
  initStore(hippoDir);

  saveActiveTaskSnapshot(hippoDir, 'default', {
    task: 'Resume the current branch cleanly',
    summary: 'Current session is about the continuity-first slice.',
    next_step: 'Use the current-session handoff, not the stale one.',
    session_id: 'sess-current',
    source: 'test',
  });

  appendSessionEvent(hippoDir, 'default', {
    session_id: 'sess-current',
    event_type: 'note',
    content: 'Checked the latest branch state and confirmed the matching handoff should drive the next action.',
    source: 'test',
  });

  saveSessionHandoff(hippoDir, 'default', {
    version: 1,
    sessionId: 'sess-old',
    summary: 'Old branch handoff',
    nextAction: 'Ship the stale branch',
    artifacts: ['src/stale.ts'],
  });

  saveSessionHandoff(hippoDir, 'default', {
    version: 1,
    sessionId: 'sess-current',
    summary: 'Current branch handoff',
    nextAction: 'Open the PR for the current branch',
    artifacts: ['src/current.ts'],
  });
}

describe('hippo context continuity assembly', () => {
  it('returns snapshot, matching handoff, and recent trail in JSON even when no memories are recalled', async () => {
    seedContinuityState();

    const out = await runHippo({ format: 'json', budget: '500' });
    const parsed = JSON.parse(out);

    expect(parsed.activeSnapshot).toBeTruthy();
    expect(parsed.activeSnapshot.session_id).toBe('sess-current');
    expect(parsed.sessionHandoff).toBeTruthy();
    expect(parsed.sessionHandoff.sessionId).toBe('sess-current');
    expect(parsed.sessionHandoff.nextAction).toBe('Open the PR for the current branch');
    expect(parsed.recentSessionEvents).toHaveLength(1);
    expect(parsed.memories).toEqual([]);
    expect(parsed.tokens).toBe(0);
  });

  it('prints the matching handoff in markdown context and excludes the stale one', async () => {
    seedContinuityState();

    const out = await runHippo({ budget: '500' });

    expect(out).toContain('## Active Task Snapshot');
    expect(out).toContain('## Session Handoff');
    expect(out).toContain('## Recent Session Trail');
    expect(out).toContain('Open the PR for the current branch');
    expect(out).not.toContain('Ship the stale branch');
  });
});
