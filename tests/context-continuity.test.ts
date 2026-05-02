import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
} from '../src/store.js';

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-context-continuity-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

function runHippo(args: string[]): string {
  const globalDir = path.join(tmpDir, 'global');
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: globalDir },
    cwd: tmpDir,
    encoding: 'utf8',
  });
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
  it('returns snapshot, matching handoff, and recent trail in JSON even when no memories are recalled', () => {
    seedContinuityState();

    const out = runHippo(['context', '--format', 'json', '--budget', '500']);
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

  it('prints the matching handoff in markdown context and excludes the stale one', () => {
    seedContinuityState();

    const out = runHippo(['context', '--budget', '500']);

    expect(out).toContain('## Active Task Snapshot');
    expect(out).toContain('## Session Handoff');
    expect(out).toContain('## Recent Session Trail');
    expect(out).toContain('Open the PR for the current branch');
    expect(out).not.toContain('Ship the stale branch');
  });
});
