// Redaction, per-session fallback, oversized-record and uninitialized-store regressions of pre-compact and compact-resume.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHippoRoot } from '../../src/base/scope/project-identity.js';
import { loadActiveTaskSnapshot, loadAllEntries } from '../_helpers/root-forms.js';
import { withScratchEnv, transcriptJsonl, runHippo, initHippo } from '../_helpers/pre-compact-e2e.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('redaction, per-session fallback and oversized-record regressions', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    await initHippo(dir, env);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('CX5: the snapshot is redacted, and pre-compact writes zero memories', async () => {
    const transcriptPath = path.join(dir, 'cx5.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'we decided to use the github token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for the deploy bot.',
          },
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Recorded that decision.' }] },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-cx5',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const hippoRoot = getHippoRoot(dir);
    expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot!.summary).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot!.task).toContain('[REDACTED]');
  });

  it("CX6: per-field fallback never carries another session's content into this session's snapshot", async () => {
    const seed = await runHippo(
      [
        'snapshot',
        'save',
        '--task',
        'SESSION A TASK',
        '--summary',
        'A summary',
        '--next-step',
        'A next',
        '--session',
        'sess-A',
      ],
      dir,
      env,
    );
    expect(seed.status).toBe(0);

    // Session B's tail has assistant text but NO plain user turn: derived
    // task is empty. Pre-fix, the fallback borrowed A's task and saved it
    // under sess-B, defeating compact-resume's session gate.
    const transcriptPath = path.join(dir, 'cx6.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output only' }] } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Session B assistant progress note. Next step: continue B work.' }],
          },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-B',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBe('sess-B');
    expect(snapshot!.task).toBe('');
    expect(snapshot!.task).not.toContain('SESSION A TASK');
    expect(snapshot!.nextStep).toContain('continue B work');
  });

  it('CX8: a PEM private-key block is redacted through the END delimiter, not just the BEGIN line', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIfakefakefakebase64payloadfakefakefake\n-----END RSA PRIVATE KEY-----';
    const transcriptPath = path.join(dir, 'cx8.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: `here is the deploy key ${pem} keep it safe.` } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Stored. Next step: rotate the key.' }] },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-cx8',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.task).not.toContain('MIIfake');
    expect(snapshot!.summary).not.toContain('MIIfake');
    expect(snapshot!.task).toContain('[REDACTED]');
  });

  it('CX9: the summary cap keeps the NEWEST turns, not the oldest', async () => {
    const turn = (marker: string) => `${marker} ${'lorem ipsum working state detail '.repeat(20)}`;
    const transcriptPath = path.join(dir, 'cx9.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: turn('OLDEST-TURN-MARKER') } },
        { type: 'user', message: { role: 'user', content: turn('turn-two') } },
        { type: 'user', message: { role: 'user', content: turn('turn-three') } },
        { type: 'user', message: { role: 'user', content: turn('NEWEST-TURN-MARKER') } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'FINAL-ASSISTANT-MARKER: continue the rollout.' }],
          },
        },
      ]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-cx9',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    // The summary source text exceeds the 2000-char cap by construction, so
    // head-first truncation would keep OLDEST and drop the assistant tail.
    expect(snapshot!.summary).toContain('FINAL-ASSISTANT-MARKER');
    expect(snapshot!.summary).not.toContain('OLDEST-TURN-MARKER');
    expect(snapshot!.summary).toContain('[...earlier turns trimmed]');
  });

  it('CX10: a structurally incomplete payload ({}) fails closed in compact-resume', async () => {
    const seed = await runHippo(
      ['snapshot', 'save', '--task', 'stale task', '--summary', 's', '--next-step', 'n'],
      dir,
      env,
    );
    expect(seed.status).toBe(0);

    const result = await runHippo(['compact-resume'], dir, env, '{}');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('CX7: an oversized final JSONL record does not swallow the tail (window grows, earlier turns survive)', async () => {
    const transcriptPath = path.join(dir, 'cx7.jsonl');
    // Final record ~600KB (> the 256KB window), shaped as a tool_result so
    // it can never win task derivation itself.
    const giant = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(600 * 1024) }] },
    };
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([
        { type: 'user', message: { role: 'user', content: 'Ship the oversized-record survival fix.' } },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Next step: verify the grown-window path.' }] },
        },
        giant,
      ]),
    );
    const logFile = path.join(dir, 'pre-compact.log');
    const payload = JSON.stringify({
      session_id: 'sess-cx7',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact', '--log-file', logFile], dir, env, payload);
    expect(result.status).toBe(0);

    const snapshot = loadActiveTaskSnapshot(getHippoRoot(dir), 'default');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionId).toBe('sess-cx7');
    expect(snapshot!.task).toContain('oversized-record survival');
    expect(fs.readFileSync(logFile, 'utf8')).toContain('tail window grown');
  });
});

describe('uninitialized store gate: neither verb may create a store', () => {
  let dir: string;
  let homeDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // HOME/USERPROFILE deliberately point at a SEPARATE scratch dir from the
    // project cwd here (unlike withScratchEnv, which collapses them). The
    // producer's diagnostic log (~/.hippo/logs/pre-compact.log) legitimately
    // creates a `.hippo` under HOME regardless of this gate — that's
    // unrelated, pre-existing, documented behavior. Separating HOME from
    // `dir` means the ONLY `.hippo` this test can observe under the PROJECT
    // dir is the store the X3 gate must prevent.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-precompact-uninit-project-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-precompact-uninit-home-'));
    env = { ...process.env, HIPPO_HOME: homeDir, HOME: homeDir, USERPROFILE: homeDir };
    // Deliberately no `initHippo(dir, env)` — this is the whole point.
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('hippo pre-compact against an uninitialized target -> exit 0, no .hippo/hippo.db created in the project dir', async () => {
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([{ type: 'user', message: { role: 'user', content: 'we decided to use PostgreSQL.' } }]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-uninit',
      transcript_path: transcriptPath,
      cwd: dir,
      hook_event_name: 'PreCompact',
    });

    const result = await runHippo(['pre-compact'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(dir, '.hippo'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.hippo', 'hippo.db'))).toBe(false);
  });

  it('hippo compact-resume against an uninitialized target -> exit 0, silent, no .hippo/hippo.db created in the project dir', async () => {
    const payload = JSON.stringify({ session_id: 'sess-uninit', source: 'compact' });
    const result = await runHippo(['compact-resume'], dir, env, payload);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(dir, '.hippo'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.hippo', 'hippo.db'))).toBe(false);
  });
});
