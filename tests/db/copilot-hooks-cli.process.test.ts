// The Copilot hook commands, run from the home folder as VS Code runs user-level hooks, so the store must come from the payload's cwd.
// Hooks run through runCli in this process; runHippo spawns the built CLI where a case reads the hook's pid, preload or env.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getHippoDbPath, HOOK_DB_WAIT_MS } from '../../src/db/index.js';
import { compactionRows } from '../_helpers/compaction-hooks.js';
import { lockWaitAskedMs, tracingLockWaits } from '../_helpers/lock-waits.js';
import { holdStoreWriteLock, releaseStoreWriteLock } from '../_helpers/store-write-lock.js';
import { copilotEventsJsonl, copilotPayload, writeCopilotSessionLog } from '../_helpers/copilot-hooks.js';
import { loadActiveTaskSnapshot, loadAllEntries } from '../_helpers/root-forms.js';
import {
  runHippo,
  CONTEXT_ARGS,
  PROJ_PIN,
  GLOBAL_PIN,
  SESSION,
  WORKER_DONE,
  s,
  hippo,
  pin,
  enableLedger,
  deliveryEvents,
  type LedgerRow,
  type FailureRow,
  rows,
  waitForLog,
  useCopilotScratch,
  removeScratch,
} from '../_helpers/copilot-hooks-cli.js';

useCopilotScratch();

let holder: ChildProcess | null = null;

afterEach(async () => {
  await releaseStoreWriteLock(holder);
  holder = null;
  removeScratch();
});

describe('hippo context --format copilot', () => {
  beforeEach(async () => {
    await pin(PROJ_PIN, false);
    await pin(GLOBAL_PIN, true);
  });

  // Payloads from docs.github.com/en/copilot/reference/hooks-reference; reply formats from the same page and VS Code's toolCallingLoop.ts.
  it('answers a camelCase sessionStart with top-level additionalContext from the payload cwd store (critic test 1)', async () => {
    const r = runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['additionalContext']);
    expect(reply.additionalContext).toContain(PROJ_PIN);
    expect(reply.additionalContext).toContain(GLOBAL_PIN);
  });

  it('answers a snake_case SessionStart from the home folder with the nested reply and the same store (critic test 2)', async () => {
    const r = await hippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['hookSpecificOutput']);
    expect(reply.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(reply.hookSpecificOutput.additionalContext).toContain(PROJ_PIN);
  });

  it('without the copilot format the same run from the home folder never sees the project store', async () => {
    const r = await hippo(
      [...CONTEXT_ARGS.slice(0, -1), 'additional-context'],
      s.dir,
      s.env,
      copilotPayload('sessionStart', s.proj),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(GLOBAL_PIN);
    expect(r.stdout).not.toContain(PROJ_PIN);
  });

  it('sends the whole block again when the same session starts again, since session start is its only injection', async () => {
    const payload = copilotPayload('sessionStart', s.proj);
    const first = await hippo(CONTEXT_ARGS, s.dir, s.env, payload);
    const again = await hippo(CONTEXT_ARGS, s.dir, s.env, payload);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).additionalContext).toBe(JSON.parse(first.stdout).additionalContext);
  });

  it('books the delivery event and the token ledger under the session id with runtime copilot (critic test 3)', async () => {
    enableLedger(s.hippoRoot);
    expect((await hippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj))).status).toBe(0);
    expect((await hippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj))).status).toBe(0);
    for (const sessionId of [SESSION, 'vscode-sess-1']) {
      const events = deliveryEvents(sessionId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runtime: 'copilot',
        session_id: sessionId,
        session_state: 'payload',
        block_state: 'sent',
      });
    }
    const ledger = rows<LedgerRow>(`SELECT session_id, event FROM token_ledger ORDER BY rowid`);
    expect(ledger).toEqual([
      { session_id: SESSION, event: 'inject' },
      { session_id: 'vscode-sess-1', event: 'inject' },
    ]);
  });
});

describe('hippo capture-error --runtime copilot (critic test 5)', () => {
  // postToolUseFailure payloads from the GH hooks reference; the error strings are synthetic, as neither harness documents them.
  it('stores no memory for a quiet grep or bash failure, and logs both in the payload cwd store', async () => {
    for (const name of ['postToolUseFailureGrep', 'postToolUseFailureBash'] as const) {
      const r = await hippo(['capture-error', '--runtime', 'copilot'], s.dir, s.env, copilotPayload(name, s.proj));
      expect(r.status, r.stderr).toBe(0);
    }
    expect(loadAllEntries(s.hippoRoot, 'default').filter((e) => e.tags.includes('error'))).toEqual([]);
    expect(rows<FailureRow>(`SELECT session_id, tool, outcome, skip_rule FROM failure_log ORDER BY rowid`)).toEqual([
      { session_id: SESSION, tool: 'grep', outcome: 'skipped-routine', skip_rule: 'search-tool' },
      { session_id: SESSION, tool: 'bash', outcome: 'skipped-routine', skip_rule: 'quiet-exit' },
    ]);
  });

  it('stores a real failure in the payload cwd store', async () => {
    const r = await hippo(
      ['capture-error', '--runtime', 'copilot'],
      s.dir,
      s.env,
      copilotPayload('postToolUseFailureBuild', s.proj),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(
      loadAllEntries(s.hippoRoot, 'default')
        .filter((e) => e.tags.includes('error'))
        .map((e) => e.content),
    ).toEqual(['bash: Command failed with exit code 2: tsc reported TS2345 in src/auth/client.ts']);
  });
});

describe('hippo session-end --runtime copilot (critic test 6)', () => {
  // sessionEnd payload from the GH hooks reference: it names no transcript, so the CLI log is found by session id.
  it('with no transcript for the session still sleeps, skips capture and exits 0', async () => {
    const logFile = path.join(s.dir, 'session-end.log');
    const r = await hippo(
      ['session-end', '--runtime', 'copilot', '--log-file', logFile],
      s.dir,
      s.env,
      copilotPayload('sessionEnd', s.proj),
    );
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('consolidating memory...');
    expect(log).toContain('skip capture: no transcript for this session');
  });

  it('captures the session from <COPILOT_HOME>/session-state/<id>/events.jsonl', async () => {
    writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'session-end.log');
    const r = await hippo(
      ['session-end', '--runtime', 'copilot', '--log-file', logFile],
      s.dir,
      s.env,
      copilotPayload('sessionEnd', s.proj),
    );
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('capturing session...');
    expect(log).not.toContain('skip capture');
    expect(
      loadAllEntries(s.hippoRoot, 'default').some((e) => e.content.includes('retry budget at three attempts')),
    ).toBe(true);
  });

  it('with no --log-file logs to copilot-sleep.log under the hippo logs folder, the file the hooks table used to name', async () => {
    const r = await hippo(['session-end', '--runtime', 'copilot'], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(path.join(s.dir, '.hippo', 'logs', 'copilot-sleep.log'), WORKER_DONE);
    expect(log).toContain('consolidating memory...');
  });
});

describe('hippo pre-compact --runtime copilot (critic test 7)', () => {
  // preCompact payload from the GH hooks reference, its transcriptPath pointing at the events.jsonl fixture.
  it('saves a working-state snapshot, opens no compaction record and prints nothing', async () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(
      ['pre-compact', '--runtime', 'copilot', '--log-file', logFile],
      s.dir,
      s.env,
      copilotPayload('preCompact', s.proj, transcript),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('snapshot saved');
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      task: 'fix the flaky login test in auth.spec.ts',
      sessionId: SESSION,
      source: 'pre-compact',
    });
  });

  it('skips a second run for the same compaction, as the Copilot CLI may fire both preCompact and PreCompact', async () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    for (let run = 0; run < 2; run++) {
      const r = await hippo(
        ['pre-compact', '--runtime', 'copilot', '--log-file', logFile],
        s.dir,
        s.env,
        copilotPayload('preCompact', s.proj, transcript),
      );
      expect(r.status, r.stderr).toBe(0);
    }
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log.match(/snapshot saved/g)).toHaveLength(1);
    expect(log).toContain(`skip: snapshot for session ${SESSION} saved under 10 s ago`);
    expect(rows<{ n: number }>(`SELECT COUNT(*) AS n FROM task_snapshots`)).toEqual([{ n: 1 }]);
  });

  it('with no payload it never falls back to scanning Claude Code transcripts', async () => {
    const claudeLog = path.join(s.dir, '.claude', 'projects', 'other', 'claude-sess.jsonl');
    fs.mkdirSync(path.dirname(claudeLog), { recursive: true });
    fs.writeFileSync(
      claudeLog,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a claude code task' } })}\n`,
    );
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.proj, s.env, '');
    expect(r.status, r.stderr).toBe(0);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('the same payload without the flag opens a record, as Claude Code has a PostCompact hook to close it', async () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = await hippo(
      ['pre-compact', '--log-file', logFile],
      s.proj,
      s.env,
      copilotPayload('preCompact', s.proj, transcript),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe('');
    expect(compactionRows(s.hippoRoot)).toHaveLength(1);
  });

  it('on a busy store waits once for the hook wait, warns once and saves no snapshot', async () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const traceDir = path.join(s.dir, 'lock-waits');
    holder = await holdStoreWriteLock(getHippoDbPath(s.hippoRoot));
    const r = runHippo(
      ['pre-compact', '--runtime', 'copilot', '--log-file', logFile],
      s.dir,
      tracingLockWaits({ ...s.env, HIPPO_LOG: 'warn' }, traceDir),
      copilotPayload('preCompact', s.proj, transcript),
    );
    await releaseStoreWriteLock(holder);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.split('\n').filter((line) => line.includes('store busy'))).toHaveLength(1);
    expect(lockWaitAskedMs(traceDir, r.pid)).toBe(HOOK_DB_WAIT_MS);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('snapshot save failed: database is locked');
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });
});
