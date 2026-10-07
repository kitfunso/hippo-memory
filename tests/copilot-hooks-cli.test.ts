// The Copilot hook commands through the built CLI, run from the home folder as VS Code runs user-level hooks, so the store must come from the payload's cwd.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { readDeliveryEvents, type DeliveryEventRow } from '../src/recall-trace.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadActiveTaskSnapshot } from '../src/store/sessions.js';
import type { JsonValue } from '../src/json.js';
import { compactionRows, initGlobal, initProject, runHippo } from './_helpers/compaction-hooks.js';
import { copilotEventsJsonl, copilotPayload, copilotScratch, writeCopilotSessionLog, type CopilotScratch } from './_helpers/copilot-hooks.js';

const CONTEXT_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'copilot'];
const PROJ_PIN = 'The proj auth client keeps its retry budget in src/auth/retry.ts';
const GLOBAL_PIN = 'Global pin: prefer small pull requests over large ones';
const SESSION = 'copilot-sess-1';
const WORKER_DONE = `active snapshot(s) for session ${SESSION}`;

let s: CopilotScratch;

function pin(text: string, global: boolean): void {
  const r = runHippo(['remember', text, '--pin', ...(global ? ['--global'] : [])], s.proj, s.env);
  expect(r.status, r.stderr).toBe(0);
}

function enableLedger(hippoRoot: string): void {
  const file = path.join(hippoRoot, 'config.json');
  // SAFETY: config.json is a JSON object hippo init wrote, or absent.
  const config = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as { [key: string]: JsonValue };
  fs.writeFileSync(file, JSON.stringify({ ...config, deliveryLedger: { enabled: true } }));
}

function deliveryEvents(sessionId: string): DeliveryEventRow[] {
  const db = openHippoDb(s.hippoRoot);
  try {
    return readDeliveryEvents(db, 'default', sessionId);
  } finally {
    closeHippoDb(db);
  }
}

interface LedgerRow { session_id: string | null; event: string }
interface FailureRow { session_id: string | null; tool: string | null; outcome: string; skip_rule: string | null }

function rows<T>(sql: string): T[] {
  const db = openHippoDb(s.hippoRoot);
  try {
    // SAFETY: every caller names the columns its row type declares.
    return db.prepare(sql).all() as T[];
  } finally {
    closeHippoDb(db);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(logFile: string, marker: string, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (text.includes(marker)) return text;
    await sleepMs(50);
  }
  throw new Error(`${marker} not logged within ${timeoutMs}ms`);
}

beforeEach(() => {
  s = copilotScratch();
  initProject(s);
  initGlobal(s);
});

afterEach(() => {
  try {
    fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The detached session-end worker can still hold a Windows lock; a leftover scratch dir is harmless.
  }
});

describe('hippo context --format copilot', () => {
  beforeEach(() => {
    pin(PROJ_PIN, false);
    pin(GLOBAL_PIN, true);
  });

  // Payloads from docs.github.com/en/copilot/reference/hooks-reference; reply formats from the same page and VS Code's toolCallingLoop.ts.
  it('answers a camelCase sessionStart with top-level additionalContext from the payload cwd store (critic test 1)', () => {
    const r = runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['additionalContext']);
    expect(reply.additionalContext).toContain(PROJ_PIN);
    expect(reply.additionalContext).toContain(GLOBAL_PIN);
  });

  it('answers a snake_case SessionStart from the home folder with the nested reply and the same store (critic test 2)', () => {
    const r = runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const reply = JSON.parse(r.stdout);
    expect(Object.keys(reply)).toEqual(['hookSpecificOutput']);
    expect(reply.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(reply.hookSpecificOutput.additionalContext).toContain(PROJ_PIN);
  });

  it('without the copilot format the same run from the home folder never sees the project store', () => {
    const r = runHippo([...CONTEXT_ARGS.slice(0, -1), 'additional-context'], s.dir, s.env, copilotPayload('sessionStart', s.proj));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(GLOBAL_PIN);
    expect(r.stdout).not.toContain(PROJ_PIN);
  });

  it('sends the whole block again when the same session starts again, since session start is its only injection', () => {
    const payload = copilotPayload('sessionStart', s.proj);
    const first = runHippo(CONTEXT_ARGS, s.dir, s.env, payload);
    const again = runHippo(CONTEXT_ARGS, s.dir, s.env, payload);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).additionalContext).toBe(JSON.parse(first.stdout).additionalContext);
  });

  it('books the delivery event and the token ledger under the session id with runtime copilot (critic test 3)', () => {
    enableLedger(s.hippoRoot);
    expect(runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('sessionStart', s.proj)).status).toBe(0);
    expect(runHippo(CONTEXT_ARGS, s.dir, s.env, copilotPayload('SessionStart', s.proj)).status).toBe(0);
    for (const sessionId of [SESSION, 'vscode-sess-1']) {
      const events = deliveryEvents(sessionId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runtime: 'copilot', session_id: sessionId, session_state: 'payload', block_state: 'sent' });
    }
    const ledger = rows<LedgerRow>(`SELECT session_id, event FROM token_ledger ORDER BY rowid`);
    expect(ledger).toEqual([{ session_id: SESSION, event: 'inject' }, { session_id: 'vscode-sess-1', event: 'inject' }]);
  });
});

describe('hippo capture-error --runtime copilot (critic test 5)', () => {
  // postToolUseFailure payloads from the GH hooks reference; the error strings are synthetic, as neither harness documents them.
  it('stores no memory for a quiet grep or bash failure, and logs both in the payload cwd store', () => {
    for (const name of ['postToolUseFailureGrep', 'postToolUseFailureBash'] as const) {
      const r = runHippo(['capture-error', '--runtime', 'copilot'], s.dir, s.env, copilotPayload(name, s.proj));
      expect(r.status, r.stderr).toBe(0);
    }
    expect(loadAllEntries(s.hippoRoot).filter((e) => e.tags.includes('error'))).toEqual([]);
    expect(rows<FailureRow>(`SELECT session_id, tool, outcome, skip_rule FROM failure_log ORDER BY rowid`)).toEqual([
      { session_id: SESSION, tool: 'grep', outcome: 'skipped-routine', skip_rule: 'search-tool' },
      { session_id: SESSION, tool: 'bash', outcome: 'skipped-routine', skip_rule: 'quiet-exit' },
    ]);
  });

  it('stores a real failure in the payload cwd store', () => {
    const r = runHippo(['capture-error', '--runtime', 'copilot'], s.dir, s.env, copilotPayload('postToolUseFailureBuild', s.proj));
    expect(r.status, r.stderr).toBe(0);
    expect(loadAllEntries(s.hippoRoot).filter((e) => e.tags.includes('error')).map((e) => e.content)).toEqual([
      'bash: Command failed with exit code 2: tsc reported TS2345 in src/auth/client.ts',
    ]);
  });
});

describe('hippo session-end --runtime copilot (critic test 6)', () => {
  // sessionEnd payload from the GH hooks reference: it names no transcript, so the CLI log is found by session id.
  it('with no transcript for the session still sleeps, skips capture and exits 0', async () => {
    const logFile = path.join(s.dir, 'session-end.log');
    const r = runHippo(['session-end', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('consolidating memory...');
    expect(log).toContain('skip capture: no transcript for this session');
  });

  it('captures the session from <COPILOT_HOME>/session-state/<id>/events.jsonl', async () => {
    writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'session-end.log');
    const r = runHippo(['session-end', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('sessionEnd', s.proj));
    expect(r.status, r.stderr).toBe(0);
    const log = await waitForLog(logFile, WORKER_DONE);
    expect(log).toContain('capturing session...');
    expect(log).not.toContain('skip capture');
    expect(loadAllEntries(s.hippoRoot).some((e) => e.content.includes('retry budget at three attempts'))).toBe(true);
  });
});

describe('hippo pre-compact --runtime copilot (critic test 7)', () => {
  // preCompact payload from the GH hooks reference, its transcriptPath pointing at the events.jsonl fixture.
  it('saves a working-state snapshot, opens no compaction record and prints nothing', () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.dir, s.env, copilotPayload('preCompact', s.proj, transcript));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(compactionRows(s.hippoRoot)).toEqual([]);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('snapshot saved');
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toMatchObject({
      task: 'fix the flaky login test in auth.spec.ts', session_id: SESSION, source: 'pre-compact',
    });
  });

  it('with no payload it never falls back to scanning Claude Code transcripts', () => {
    const claudeLog = path.join(s.dir, '.claude', 'projects', 'other', 'claude-sess.jsonl');
    fs.mkdirSync(path.dirname(claudeLog), { recursive: true });
    fs.writeFileSync(claudeLog, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a claude code task' } })}\n`);
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--runtime', 'copilot', '--log-file', logFile], s.proj, s.env, '');
    expect(r.status, r.stderr).toBe(0);
    expect(loadActiveTaskSnapshot(s.hippoRoot, 'default')).toBeNull();
  });

  it('the same payload without the flag opens a record, as Claude Code has a PostCompact hook to close it', () => {
    const transcript = writeCopilotSessionLog(s.copilotHome, SESSION, copilotEventsJsonl());
    const logFile = path.join(s.dir, 'pre-compact.log');
    const r = runHippo(['pre-compact', '--log-file', logFile], s.proj, s.env, copilotPayload('preCompact', s.proj, transcript));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe('');
    expect(compactionRows(s.hippoRoot)).toHaveLength(1);
  });
});
