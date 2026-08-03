import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getHippoRoot,
  loadActiveTaskSnapshot,
  saveActiveTaskSnapshot,
  appendSessionEvent,
  loadAllEntries,
} from '../src/store.js';
import { defaultSleepLogPath } from '../src/hooks.js';
import {
  PRE_COMPACT_TASK_CAP,
  PRE_COMPACT_SUMMARY_CAP,
  PRE_COMPACT_NEXT_STEP_CAP,
} from '../src/capture.js';

// Always run against the local built CLI so we're testing our source, not a
// stale globally-installed version (mirrors tests/pinned-inject.test.ts).
const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

/**
 * Scratch $HOME + $HIPPO_HOME + tmp cwd for every test — never a repo
 * checkout (PROBATION: feedback_hippo_probe_scratch_stores). HOME/USERPROFILE
 * are overridden too so `resolveLastSessionTranscript`'s auto-discovery under
 * ~/.claude/projects/ and `defaultSleepLogPath()` can never see the real
 * developer machine.
 */
function withScratchEnv(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-precompact-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIPPO_HOME: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  return { dir, env };
}

function transcriptJsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function runHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
  });
}

function initHippo(cwd: string, env: NodeJS.ProcessEnv): void {
  const result = runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], cwd, env);
  expect(result.status).toBe(0);
}

describe('hippo pre-compact (PreCompact hook producer, real store)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a task_snapshots row (source=pre-compact, payload session_id) and extracts memories from a synthetic transcript', () => {
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'Please set up the new payment webhook handler.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Sure, I'll wire up the webhook handler now." }] } },
        { type: 'user', message: { role: 'user', content: 'we decided to use PostgreSQL for the new backend service layer.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Got it, using PostgreSQL. Implementing the schema next.' }] } },
        { type: 'user', message: { role: 'user', content: "Now let's also add rate limiting to the endpoint." } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal planning, must not leak into next_step' },
              { type: 'tool_use', name: 'Edit', input: {} },
              { type: 'text', text: 'Next step: add the rate limiter middleware and write tests for it.' },
            ],
          },
        },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-precompact-e2e-1',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const hippoRoot = getHippoRoot(dir);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.source).toBe('pre-compact');
    expect(snapshot!.session_id).toBe('sess-precompact-e2e-1');
    expect(snapshot!.task).toContain('rate limiting');
    expect(snapshot!.next_step).toContain('rate limiter middleware');
    expect(snapshot!.summary).toContain('PostgreSQL');

    const entries = loadAllEntries(hippoRoot, 'default');
    const decision = entries.find((e) => e.content.includes('PostgreSQL'));
    expect(decision).toBeDefined();
  });

  it('missing transcript_path (no auto-discovery fallback in the scratch env) -> exit 0, no snapshot written', () => {
    const payload = JSON.stringify({
      session_id: 'sess-missing',
      transcript_path: path.join(dir, 'does-not-exist.jsonl'),
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('positive control: manual invocation (no payload transcript_path) DOES pick up a transcript via auto-discovery', () => {
    // Proves discovery is reachable in this scratch env, so the negative
    // (contamination) case below is a real regression guard, not a test
    // that trivially passes because nothing was ever discoverable.
    // resolveLastSessionTranscript's auto-discovery root is
    // <HOME|USERPROFILE>/.claude/projects/<any>/*.jsonl — HOME and
    // USERPROFILE are both `dir` in this scratch env (see withScratchEnv).
    const discoveredProjectDir = path.join(dir, '.claude', 'projects', 'some-project');
    fs.mkdirSync(discoveredProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(discoveredProjectDir, 'discoverable-transcript.jsonl'),
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use MongoDB for the discoverable session.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DISCOVERABLE SESSION marker text.' }] } },
      ]),
    );

    // No transcript_path field at all — a genuine manual invocation.
    const payload = JSON.stringify({ cwd: dir, hook_event_name: 'PreCompact' });
    const result = runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.summary).toContain('DISCOVERABLE SESSION');
  });

  it('contamination regression: payload transcript_path present but unreadable -> SKIP, never falls back to a decoy found via auto-discovery', () => {
    // Plant a decoy exactly where auto-discovery looks. If the producer
    // ever fell back to discovery when the payload's own path is
    // unreadable, it would snapshot THIS decoy under the payload's
    // session_id — cross-session contamination with wrong linkage
    // (verify-stage finding, 2026-08-03).
    const decoyProjectDir = path.join(dir, '.claude', 'projects', 'decoy-project');
    fs.mkdirSync(decoyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyProjectDir, 'decoy-transcript.jsonl'),
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use MongoDB for the decoy session, this must never leak.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'DECOY SESSION marker — must never be snapshotted under another session id.' }] } },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-real-but-path-unreadable',
      transcript_path: path.join(dir, 'does-not-exist-real-transcript.jsonl'),
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const result = runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    const hippoRoot = getHippoRoot(dir);
    expect(loadActiveTaskSnapshot(hippoRoot, 'default')).toBeNull();
    const entries = loadAllEntries(hippoRoot, 'default');
    const leaked = entries.find((e) => e.content.includes('MongoDB') || e.content.toLowerCase().includes('decoy'));
    expect(leaked).toBeUndefined();
  });

  it('malformed stdin (not JSON at all) -> exit 0, no snapshot written', () => {
    const result = runHippo(['pre-compact'], dir, env, 'this is not json at all');
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('empty transcript file -> exit 0, no snapshot written (skip rule: empty summary + no extracted items)', () => {
    const transcriptPath = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const payload = JSON.stringify({
      session_id: 'sess-empty',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('caps task/summary/next_step at 200/2000/500 chars; hippo snapshot save stays uncapped', () => {
    const longTask = 'X'.repeat(400);
    const longAssistantText = 'Y'.repeat(1000);
    // Big filler chunks so the RAW summary (before the producer's own cap)
    // exceeds PRE_COMPACT_SUMMARY_CAP — otherwise the cap assertion would
    // pass trivially without proving truncation actually happened.
    const bigChunks = Array.from({ length: 5 }, (_, i) => `Chunk ${i}: ${'Z'.repeat(500)}`);

    const transcriptPath = path.join(dir, 'oversized.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: longTask } },
        ...bigChunks.map((text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })),
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: longAssistantText }] } },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-caps',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const hippoRoot = getHippoRoot(dir);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task.length).toBeLessThanOrEqual(PRE_COMPACT_TASK_CAP);
    expect(snapshot!.task.length).toBe(PRE_COMPACT_TASK_CAP); // proves truncation, not coincidence
    expect(snapshot!.summary.length).toBeLessThanOrEqual(PRE_COMPACT_SUMMARY_CAP);
    expect(snapshot!.summary.length).toBe(PRE_COMPACT_SUMMARY_CAP);
    expect(snapshot!.next_step.length).toBeLessThanOrEqual(PRE_COMPACT_NEXT_STEP_CAP);
    expect(snapshot!.next_step.length).toBe(PRE_COMPACT_NEXT_STEP_CAP);

    // The shared `saveActiveTaskSnapshot` / `hippo snapshot save` CLI path is
    // untouched — caps are enforced in the pre-compact producer ONLY.
    const uncappedText = 'Q'.repeat(3000);
    const saveResult = runHippo(
      ['snapshot', 'save', '--task', uncappedText, '--summary', uncappedText, '--next-step', uncappedText],
      dir,
      env,
    );
    expect(saveResult.status).toBe(0);
    const manualSnapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(manualSnapshot!.task.length).toBe(3000);
    expect(manualSnapshot!.summary.length).toBe(3000);
    expect(manualSnapshot!.next_step.length).toBe(3000);
  });
});

describe('hippo compact-resume (SessionStart(compact) injector, real store)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('source: "compact" -> stdout contains the task, next step, and session trail', () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'add rate limiting to the endpoint',
      summary: 'Implemented the webhook handler; decided on PostgreSQL; now adding rate limiting.',
      next_step: 'Add the rate limiter middleware and write tests for it.',
      source: 'pre-compact',
      session_id: 'sess-resume-1',
    });
    appendSessionEvent(hippoRoot, 'default', {
      session_id: 'sess-resume-1',
      event_type: 'note',
      content: 'decided to use PostgreSQL for the backend',
    });

    const payload = JSON.stringify({ session_id: 'sess-resume-1', source: 'compact' });
    const result = runHippo(['compact-resume'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Restored after compaction');
    expect(result.stdout).toContain('add rate limiting to the endpoint');
    expect(result.stdout).toContain('Add the rate limiter middleware');
    expect(result.stdout).toContain('decided to use PostgreSQL for the backend');
  });

  it('source: "startup" -> empty stdout, exit 0 (matcher-defence-in-depth)', () => {
    saveActiveTaskSnapshot(getHippoRoot(dir), 'default', {
      task: 't', summary: 's', next_step: 'n', source: 'pre-compact', session_id: 'sess-x',
    });

    const payload = JSON.stringify({ session_id: 'sess-x', source: 'startup' });
    const result = runHippo(['compact-resume'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('malformed payload -> exit 0 (falls through to the manual-use print path)', () => {
    saveActiveTaskSnapshot(getHippoRoot(dir), 'default', {
      task: 'manual-use task', summary: 's', next_step: 'n', source: 'pre-compact',
    });

    const result = runHippo(['compact-resume'], dir, env, 'not json');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('manual-use task');
  });

  it('no active snapshot -> exit 0, empty stdout (nothing to restore)', () => {
    const payload = JSON.stringify({ session_id: 'sess-none', source: 'compact' });
    const result = runHippo(['compact-resume'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('corrupted store (hippo.db is not a valid sqlite file) -> exit 0, no crash/stack leaked to stdout', () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'task before corruption', summary: 's', next_step: 'n', source: 'pre-compact', session_id: 'sess-corrupt',
    });

    // Genuinely corrupt the store: overwrite the main db file with garbage
    // bytes and drop any WAL/SHM sidecars so a valid WAL can't mask the
    // corruption when the child process re-opens it.
    const dbPath = path.join(hippoRoot, 'hippo.db');
    fs.writeFileSync(dbPath, 'not a valid sqlite database file, just garbage bytes 0000000', 'utf8');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = dbPath + suffix;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
    }

    const payload = JSON.stringify({ session_id: 'sess-corrupt', source: 'compact' });
    const result = runHippo(['compact-resume'], dir, env, payload);

    expect(result.status).toBe(0);
    // loadActiveTaskSnapshot throws before any console.log runs, so the
    // degrade-to-empty-stdout contract means stdout is empty here — but we
    // assert the weaker "no crash leaked" condition too, matching the
    // store-error requirement without over-coupling to the exact message.
    expect(result.stdout).not.toMatch(/at Object\.|node:internal|Uncaught|Error:|SQLITE_/i);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('combined firing: last-sleep + compact-resume against the same store/log state', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    ({ dir, env } = withScratchEnv());
    initHippo(dir, env);
    saveActiveTaskSnapshot(getHippoRoot(dir), 'default', {
      task: 'combined-firing task',
      summary: 'combined-firing summary',
      next_step: 'combined-firing next step',
      source: 'pre-compact',
      session_id: 'sess-combo',
    });
    // This block computes `defaultSleepLogPath()` in the TEST process itself
    // (to pre-seed / assert on the log file) — it must resolve to the same
    // scratch dir as the spawned child's env, or it reads/writes the real
    // developer machine's ~/.hippo/logs/.
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no pending session-end log: last-sleep is silent, compact-resume block is intact', () => {
    expect(fs.existsSync(defaultSleepLogPath())).toBe(false);

    const lastSleep = runHippo(['last-sleep'], dir, env);
    expect(lastSleep.status).toBe(0);
    expect(lastSleep.stdout.trim()).toBe('');

    const compactResume = runHippo(['compact-resume'], dir, env, JSON.stringify({ session_id: 'sess-combo', source: 'compact' }));
    expect(compactResume.status).toBe(0);
    expect(compactResume.stdout).toContain('Restored after compaction');
    expect(compactResume.stdout).toContain('combined-firing task');
    expect(compactResume.stdout).not.toContain('Previous session hippo consolidation');
  });

  it('pending session-end log present: both blocks print, neither corrupts the other', () => {
    const logPath = defaultSleepLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '[hippo] a previous session already consolidated memory\n', 'utf8');

    const lastSleep = runHippo(['last-sleep'], dir, env);
    expect(lastSleep.status).toBe(0);
    expect(lastSleep.stdout).toContain('Previous session hippo consolidation');
    expect(lastSleep.stdout).toContain('a previous session already consolidated memory');
    // last-sleep clears the log by default — confirms it ran the real path,
    // not a no-op, and that clearing doesn't touch the sqlite-backed snapshot.
    expect(fs.existsSync(logPath)).toBe(false);

    const compactResume = runHippo(['compact-resume'], dir, env, JSON.stringify({ session_id: 'sess-combo', source: 'compact' }));
    expect(compactResume.status).toBe(0);
    expect(compactResume.stdout).toContain('Restored after compaction');
    expect(compactResume.stdout).toContain('combined-firing task');
    // Neither call's output leaked into the other's.
    expect(compactResume.stdout).not.toContain('Previous session hippo consolidation');
    expect(lastSleep.stdout).not.toContain('Restored after compaction');
  });
});
