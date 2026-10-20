// The PreCompact hook producer against a real store.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHippoRoot } from '../../src/core/project-identity.js';
import { WORKING_STATE_CAPS } from '../../src/capture/working-state.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import {
  loadActiveTaskSnapshot,
  writeSessionEndHandoff,
  loadAllEntries,
  saveActiveTaskSnapshot,
} from '../_helpers/root-forms.js';
import { withScratchEnv, transcriptJsonl, runHippo, spawnHippo, initHippo } from '../_helpers/pre-compact-e2e.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const FAKE_JWT = ['eyJ' + 'FAKEHEADER', 'eyJ' + 'FAKEPAYLOAD', 'FAKESIG'].join('.');

describe('hippo pre-compact (PreCompact hook producer, real store)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    await initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a task_snapshots row (source=pre-compact, payload session_id) and writes zero memories', async () => {
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'Please set up the new payment webhook handler.' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: "Sure, I'll wire up the webhook handler now." }],
          },
        },
        {
          type: 'user',
          message: { role: 'user', content: 'we decided to use PostgreSQL for the new backend service layer.' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Got it, using PostgreSQL. Implementing the schema next.' }],
          },
        },
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
        // Meta/sidechain lines are type:'user'/'assistant' but not the human
        // or this session: a prior compaction's summary (isMeta) and a
        // sub-agent turn (isSidechain) trail the real turns here and must
        // NOT win task/next_step derivation.
        {
          type: 'user',
          isMeta: true,
          message: { role: 'user', content: 'COMPACT SUMMARY META LINE - must not become the task' },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'SIDECHAIN NEXT STEP - must not become next_step' }],
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

    const result = await spawnHippo(['pre-compact'], dir, env, payload);
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
    expect(entries).toHaveLength(0);
  });

  it('last user line is a Claude Code system notification -> Task falls back to the previous typed line, notice stays out of Summary', async () => {
    const transcriptPath = path.join(dir, 'system-notification.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'fix the login bug' } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Looking into the login bug now.' }] },
        },
        {
          type: 'user',
          promptSource: 'system',
          message: {
            role: 'user',
            content: '<task-notification>Another Claude session finished a task.</task-notification>',
          },
        },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-system-notification',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task).toBe('fix the login bug');
    expect(snapshot!.summary).not.toContain('task-notification');
    expect(snapshot!.summary).not.toContain('Another Claude session');
  });

  it('missing transcript_path (no auto-discovery fallback in the scratch env) -> exit 0, no snapshot written', async () => {
    const payload = JSON.stringify({
      session_id: 'sess-missing',
      transcript_path: path.join(dir, 'does-not-exist.jsonl'),
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('positive control: true manual invocation (no stdin at all) DOES pick up a transcript via auto-discovery', async () => {
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
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'DISCOVERABLE SESSION marker text.' }] },
        },
      ]),
    );

    // X4 (review round): auto-discovery now only runs on a TRUE manual
    // invocation — no stdin at all (TTY, or a non-TTY read that yields
    // empty). A piped JSON payload with no transcript_path field is no
    // longer "manual" — it fails closed instead (see the dedicated
    // malformed/missing-transcript_path test below). So this positive
    // control passes NO input whatsoever, matching a real interactive run.
    const result = await runHippo(['pre-compact'], dir, env);

    expect(result.status).toBe(0);
    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.summary).toContain('DISCOVERABLE SESSION');
  });

  it('fail-closed (X4): non-empty stdin JSON object with no transcript_path field -> exit 0, skip, no auto-discovery fallback', async () => {
    // Companion to the positive control above: the same payload shape, but
    // sent as real (non-empty) stdin rather than omitted entirely. A decoy
    // transcript sits exactly where auto-discovery would look; the fixed
    // contract must never reach it.
    const decoyProjectDir = path.join(dir, '.claude', 'projects', 'decoy-no-path');
    fs.mkdirSync(decoyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyProjectDir, 'decoy.jsonl'),
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use MongoDB, this must never leak.' } },
      ]),
    );

    const payload = JSON.stringify({ cwd: dir, hook_event_name: 'PreCompact' });
    const result = await runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('fail-closed (X4): "transcript_path": null -> exit 0, skip, no auto-discovery fallback', async () => {
    const decoyProjectDir = path.join(dir, '.claude', 'projects', 'decoy-null-path');
    fs.mkdirSync(decoyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyProjectDir, 'decoy.jsonl'),
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use MongoDB, this must never leak either.' } },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-null-path',
      transcript_path: null,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const result = await runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('X11: payload transcript_path not ending .jsonl -> exit 0, skip', async () => {
    const transcriptPath = path.join(dir, 'transcript.txt');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'this file is readable but has the wrong extension.' } },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-wrong-ext',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const result = await runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('contamination regression: payload transcript_path present but unreadable -> SKIP, never falls back to a decoy found via auto-discovery', async () => {
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
        {
          type: 'user',
          message: { role: 'user', content: 'we decided to use MongoDB for the decoy session, this must never leak.' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'DECOY SESSION marker — must never be snapshotted under another session id.' },
            ],
          },
        },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-real-but-path-unreadable',
      transcript_path: path.join(dir, 'does-not-exist-real-transcript.jsonl'),
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const result = await runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    const hippoRoot = getHippoRoot(dir);
    expect(loadActiveTaskSnapshot(hippoRoot, 'default')).toBeNull();
    const entries = loadAllEntries(hippoRoot, 'default');
    const leaked = entries.find((e) => e.content.includes('MongoDB') || e.content.toLowerCase().includes('decoy'));
    expect(leaked).toBeUndefined();
  });

  it('malformed stdin (not JSON at all) -> exit 0, no snapshot written', async () => {
    const result = await runHippo(['pre-compact'], dir, env, 'this is not json at all');
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('empty transcript file -> exit 0, no snapshot written (skip rule: empty summary)', async () => {
    const transcriptPath = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const payload = JSON.stringify({
      session_id: 'sess-empty',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(loadActiveTaskSnapshot(getHippoRoot(dir), 'default')).toBeNull();
  });

  it('caps task/summary/next_step at 200/2000/500 chars; hippo snapshot save stays uncapped', async () => {
    const longTask = 'X'.repeat(400);
    const longAssistantText = 'Y'.repeat(1000);
    // Big filler chunks so the RAW summary (before the producer's own cap)
    // exceeds the summary cap — otherwise the cap assertion would
    // pass trivially without proving truncation actually happened.
    const bigChunks = Array.from({ length: 5 }, (_, i) => `Chunk ${i}: ${'Z'.repeat(500)}`);

    const transcriptPath = path.join(dir, 'oversized.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: longTask } },
        ...bigChunks.map((text) => ({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })),
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: longAssistantText }] } },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-caps',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const hippoRoot = getHippoRoot(dir);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.task);
    expect(snapshot!.task.length).toBe(WORKING_STATE_CAPS.task); // proves truncation, not coincidence
    // Summary caps from the RECENT end and carries a fixed trim marker
    // (CX9), so its budget already counts the marker, and truncation is
    // proven by the marker rather than an exact length.
    const TRIM_MARKER = '[...earlier turns trimmed]\n';
    expect(snapshot!.summary.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.summary);
    expect(snapshot!.summary.startsWith(TRIM_MARKER)).toBe(true);
    expect(snapshot!.next_step.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.next_step);
    expect(snapshot!.next_step.length).toBe(WORKING_STATE_CAPS.next_step);

    // The shared `saveActiveTaskSnapshot` / `hippo snapshot save` CLI path is
    // untouched — caps are enforced in the pre-compact producer ONLY.
    const uncappedText = 'Q'.repeat(3000);
    const saveResult = await runHippo(
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

  it('X1: per-field merge — a tool-heavy tail with no plain-text user turn keeps the existing task instead of blanking it', async () => {
    const hippoRoot = getHippoRoot(dir);
    saveActiveTaskSnapshot(hippoRoot, 'default', {
      task: 'user-authored task must survive',
      summary: 'previous summary',
      next_step: 'previous next step',
      source: 'cli',
      session_id: 'sess-merge',
    });

    // Every user turn is a tool_result array, not plain text — summariseTranscript's
    // lastTurnText derives '' for task, but the assistant text still
    // yields a non-empty summary/next_step, so this must NOT be a full skip.
    const transcriptPath = path.join(dir, 'tool-heavy.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'some tool output' }] } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Ran the tool, next step: verify the output.' }],
          },
        },
      ]),
    );

    const payload = JSON.stringify({
      session_id: 'sess-merge',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });
    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    // Task was never re-derivable from this tail — the existing field survives.
    expect(snapshot!.task).toBe('user-authored task must survive');
    // Summary/next_step WERE derivable — they get overwritten as normal.
    expect(snapshot!.next_step).toContain('verify the output');
  });

  it('X7: corrupted store (hippo.db is not a valid sqlite file) -> exit 0, no crash output', async () => {
    const hippoRoot = getHippoRoot(dir);
    const dbPath = path.join(hippoRoot, 'hippo.db');
    fs.writeFileSync(dbPath, 'not a valid sqlite database file, just garbage bytes 0000000', 'utf8');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = dbPath + suffix;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
    }

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'we decided to use PostgreSQL after the store broke.' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Next step: verify the corrupted-store path.' }],
          },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-corrupt-producer',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/at Object\.|node:internal|Uncaught|Error:|SQLITE_/i);
    expect(result.stderr).not.toMatch(/at Object\.<anonymous>|node:internal|Uncaught|SQLITE_/i);
  });

  it('X9: secret-shaped content in the transcript is redacted before it lands in the snapshot fields', async () => {
    const transcriptPath = path.join(dir, 'secret.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'the github token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is what we use.',
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Noted the github token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Next step: rotate it.',
              },
            ],
          },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-secret',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot!.summary).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot!.next_step).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot!.task).toContain('[REDACTED]');
    expect(snapshot!.summary).toContain('[REDACTED]');
    expect(snapshot!.next_step).toContain('[REDACTED]');
  });

  it('a Bearer JWT an older build left in the snapshot survives neither compaction nor the session-end handoff', async () => {
    const hippoRoot = getHippoRoot(dir);
    // Raw SQL, because saveActiveTaskSnapshot now scrubs: this is the row a build without the scrub left behind.
    const db = openHippoDb(hippoRoot);
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, tenant_id, created_at, updated_at)
         VALUES ('ship the export', 'export wired', ?, 'active', 'cli', 'sess-old-jwt', 'default', ?, ?)`,
      ).run(`retry the export with Authorization: Bearer ${FAKE_JWT}`, now, now);
    } finally {
      closeHippoDb(db);
    }
    const transcriptPath = path.join(dir, 'carry-jwt.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'Keep going with the export.' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-old-jwt',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    expect((await runHippo(['pre-compact'], dir, env, payload)).status).toBe(0);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot!.next_step).toBe('retry the export with Authorization: [REDACTED]');
    const handoff = writeSessionEndHandoff(hippoRoot, {
      tenantId: 'default',
      sessionId: 'sess-old-jwt',
      evidence: null,
    });
    expect(handoff!.nextAction).toBe('retry the export with Authorization: [REDACTED]');
  });

  it('hippo snapshot save stores a JWT scrubbed', async () => {
    const result = await runHippo(
      [
        'snapshot',
        'save',
        '--task',
        'call the export API',
        '--summary',
        `the token is ${FAKE_JWT}`,
        '--next-step',
        `use Bearer ${FAKE_JWT}`,
      ],
      dir,
      env,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('eyJ');
    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot!.summary).toBe('the token is [REDACTED]');
    expect(snapshot!.next_step).toBe('use [REDACTED]');
  });
});
