import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnSync } from 'child_process';
import { summariseTranscript, resolveLastSessionTranscript } from '../src/capture.js';

/**
 * Per-test tmpdir so the fake transcript fixtures don't leak between cases.
 */
function withTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-capture-test-'));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function transcriptJsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('summariseTranscript', () => {
  it('extracts plain-string user messages and assistant text blocks', () => {
    const jsonl = transcriptJsonl([
      { type: 'permission-mode', permissionMode: 'default' }, // should be ignored
      { type: 'user', message: { role: 'user', content: 'please add feature X' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal monologue' }, // skipped
            { type: 'text', text: 'Sure, implementing feature X now.' },
            { type: 'tool_use', name: 'Edit', input: {} }, // skipped
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'noisy tool output' }], // skipped
        },
      },
    ]);

    const summary = summariseTranscript(jsonl);
    expect(summary).toContain('please add feature X');
    expect(summary).toContain('Sure, implementing feature X now.');
    expect(summary).not.toContain('internal monologue');
    expect(summary).not.toContain('noisy tool output');
  });

  it('extracts user and assistant text from Codex rollout transcripts', () => {
    const jsonl = transcriptJsonl([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'developer instructions' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'please build the codex wrapper' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'I am adding the failing tests first.' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'duplicate commentary copy that should not be required',
          phase: 'commentary',
        },
      },
    ]);

    const summary = summariseTranscript(jsonl);
    expect(summary).toContain('please build the codex wrapper');
    expect(summary).toContain('I am adding the failing tests first.');
    expect(summary).not.toContain('developer instructions');
  });

  it('keeps only the last 20 user messages (tail only)', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      type: 'user',
      message: { role: 'user', content: `msg ${i}` },
    }));
    const summary = summariseTranscript(transcriptJsonl(entries));

    expect(summary).not.toContain('msg 0');
    expect(summary).not.toContain('msg 9');
    expect(summary).toContain('msg 10');
    expect(summary).toContain('msg 29');
  });

  it('returns empty string when the transcript has no user/assistant messages', () => {
    const jsonl = transcriptJsonl([
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'system', content: 'system msg' },
    ]);
    expect(summariseTranscript(jsonl)).toBe('');
  });

  it('tolerates malformed JSONL lines', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      'not valid json',
      '',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'world' } }),
    ].join('\n');

    const summary = summariseTranscript(jsonl);
    expect(summary).toContain('hello');
    expect(summary).toContain('world');
  });
});

describe('resolveLastSessionTranscript', () => {
  let tmp: { dir: string; cleanup: () => void };
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmp = withTmpDir();
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmp.dir;
    process.env.USERPROFILE = tmp.dir;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    tmp.cleanup();
  });

  it('prefers an explicit transcript path when the file exists', () => {
    const file = path.join(tmp.dir, 'explicit.jsonl');
    fs.writeFileSync(file, '{}');
    expect(resolveLastSessionTranscript(file, undefined)).toBe(file);
  });

  it('falls back to stdin JSON payload with transcript_path (Claude Code SessionEnd shape)', () => {
    const file = path.join(tmp.dir, 'from-stdin.jsonl');
    fs.writeFileSync(file, '{}');
    const payload = JSON.stringify({
      session_id: 'abc',
      transcript_path: file,
      cwd: tmp.dir,
    });
    expect(resolveLastSessionTranscript(undefined, payload)).toBe(file);
  });

  it('auto-discovers the newest transcript under ~/.claude/projects/', () => {
    const projects = path.join(tmp.dir, '.claude', 'projects', 'proj-a');
    fs.mkdirSync(projects, { recursive: true });
    const older = path.join(projects, 'older.jsonl');
    const newer = path.join(projects, 'newer.jsonl');
    fs.writeFileSync(older, '{}');
    fs.writeFileSync(newer, '{}');
    // Force older mtime into the past so newer wins deterministically
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);

    expect(resolveLastSessionTranscript(undefined, undefined)).toBe(newer);
  });

  it('returns null when no transcript can be located', () => {
    expect(resolveLastSessionTranscript(undefined, undefined)).toBeNull();
  });

  it('does not throw on a non-existent explicit path', () => {
    const bogus = path.join(tmp.dir, 'nope.jsonl');
    // Falls through to stdin + auto-discover, both unavailable here
    expect(resolveLastSessionTranscript(bogus, undefined)).toBeNull();
  });

  it('does not throw on non-JSON stdin text', () => {
    expect(resolveLastSessionTranscript(undefined, 'some plain text')).toBeNull();
  });
});

describe('hippo capture --last-session --log-file (end-to-end via CLI)', () => {
  let tmp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    tmp = withTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('tees banner + completion message to the log file and appends (does not truncate)', () => {
    const transcript = path.join(tmp.dir, 't.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: "let's go with PostgreSQL" },
      }) + '\n',
    );

    const logFile = path.join(tmp.dir, 'session.log');
    // Simulate `hippo sleep --log-file` having already written its output —
    // capture runs second in the SessionEnd sequence and must append.
    fs.writeFileSync(logFile, '[hippo] sleep complete\n', 'utf8');

    // Init a hippo store in the tmp cwd so capture doesn't bail out
    // on `No .hippo directory found`.
    const binPath = path.resolve(process.cwd(), 'bin', 'hippo.js');
    const init = spawnSync(
      process.execPath,
      [binPath, 'init', '--no-hooks', '--no-schedule', '--no-learn'],
      {
        cwd: tmp.dir,
        // HIPPO_HOME isolates the global store. `hippo init` registers the
        // workspace into <globalRoot>/workspaces.json; without this it writes
        // the developer's real ~/.hippo registry.
        env: { ...process.env, HIPPO_HOME: tmp.dir },
        stdio: 'ignore',
      },
    );
    expect(init.status).toBe(0);

    // Spawn the actual CLI so we exercise the same code path the hook runs.
    // Use --dry-run so no hippo store writes are needed; we only care that
    // the tee wrapper captures stdout.
    const result = spawnSync(
      process.execPath,
      [
        binPath,
        'capture',
        '--last-session',
        '--transcript',
        transcript,
        '--log-file',
        logFile,
        '--dry-run',
      ],
      {
        cwd: tmp.dir,
        env: { ...process.env, HIPPO_HOME: tmp.dir },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);

    const contents = fs.readFileSync(logFile, 'utf8');
    expect(contents).toContain('[hippo] sleep complete');   // preserved
    expect(contents).toContain('capturing session...');      // banner appended
    expect(contents).toContain('[hippo] capture complete');  // completion marker
  });
});
