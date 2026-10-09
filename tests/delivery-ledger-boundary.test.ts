// The two compaction hooks through the built CLI: which delivery_events row each one leaves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blockHash, estimateTokens } from '../src/token-ledger.js';
import { copilotPayload } from './_helpers/copilot-hooks.js';
import {
  PROMPT_HOOK, SNAPSHOT_TASK, dispose, eventCount, eventsN, hippo, hippoAsync, installCopilotHooksFile, preCompactPayload, project,
  promptPayload, resumePayload, saveSnapshot, tableRows, writeConfig, writeTranscript, writeVscodeTranscript, type Project,
} from './_helpers/delivery-boundary.js';

let p: Project;

beforeEach(() => {
  p = project();
});

afterEach(() => {
  dispose(p);
});

describe('what one boundary hook call records', () => {
  it('B1: a Claude Code PreCompact payload leaves one sent row priced on the summariser text', () => {
    const r = hippo(p, ['pre-compact'], { input: preCompactPayload('b1') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe('');
    const [e] = eventsN(p, 'b1', 1);
    expect([e.event_type, e.runtime, e.surface, e.session_state, e.turn_seq, e.block_state, e.ledger_version])
      .toEqual(['pre-compact', 'claude-code', 'hook', 'payload', 1, 'sent', 2]);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
    expect([e.candidates, e.considered_count, e.emitted_count, e.rejected_count]).toEqual([[], 0, 0, 0]);
  });

  it('B3: compact-resume with a fresh snapshot of the same session leaves one sent row and its token-ledger row', () => {
    saveSnapshot(p, 'b3');
    const r = hippo(p, ['compact-resume'], { input: resumePayload('b3') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(SNAPSHOT_TASK);
    const [e] = eventsN(p, 'b3', 1);
    expect([e.event_type, e.session_state, e.turn_seq, e.block_state]).toEqual(['compact-resume', 'payload', 1, 'sent']);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
    expect(tableRows(p, `SELECT event FROM token_ledger WHERE surface = 'compact_resume' AND session_id = 'b3'`)).toHaveLength(1);
  });

  it('B2: pre-compact --runtime copilot leaves one empty row with runtime copilot and prints nothing', () => {
    const payload = copilotPayload('preCompact', p.cwd, 'no-such-transcript.jsonl');
    const r = hippo(p, ['pre-compact', '--runtime', 'copilot'], { input: payload });
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'copilot-sess-1', 1);
    expect([e.event_type, e.runtime, e.block_state, e.emitted_hash, e.injected_tokens]).toEqual(['pre-compact', 'copilot', 'empty', null, 0]);
  });

  it('B4: compact-resume records empty without a snapshot, empty for another session, disabled in the holdout arm', () => {
    expect(hippo(p, ['compact-resume'], { input: resumePayload('b4-none') }).stdout).toBe('');
    saveSnapshot(p, 'other-session');
    expect(hippo(p, ['compact-resume'], { input: resumePayload('b4-mismatch') }).stdout).toBe('');
    writeConfig(p, { holdout: true });
    saveSnapshot(p, 'b4-holdout');
    expect(hippo(p, ['compact-resume'], { input: resumePayload('b4-holdout') }).stdout).toBe('');
    expect([
      eventsN(p, 'b4-none', 1)[0].block_state, eventsN(p, 'b4-mismatch', 1)[0].block_state, eventsN(p, 'b4-holdout', 1)[0].block_state,
    ]).toEqual(['empty', 'empty', 'disabled']);
  });

  it('B6: a sub-agent payload leaves one subagent row with no turn number, on both hooks', () => {
    saveSnapshot(p, 'b6');
    const resume = hippo(p, ['compact-resume'], { input: resumePayload('b6', { agent_id: 'agent-1' }) });
    const pre = hippo(p, ['pre-compact'], { input: preCompactPayload('b6', { agent_id: 'agent-1' }) });
    expect([resume.status, resume.stdout]).toEqual([0, '']);
    expect(pre.status).toBe(0);
    const rows = eventsN(p, 'b6', 2);
    expect(rows.map((e) => [e.event_type, e.session_state, e.turn_seq, e.block_state])).toEqual([
      ['compact-resume', 'subagent', null, 'empty'],
      ['pre-compact', 'subagent', null, 'sent'],
    ]);
  });

  it('V6: a sub-agent payload on compact-resume in a holdout session records empty, not disabled', () => {
    writeConfig(p, { holdout: true });
    saveSnapshot(p, 'v6');
    const r = hippo(p, ['compact-resume'], { input: resumePayload('v6', { agent_id: 'agent-1' }) });
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'v6', 1);
    expect([e.session_state, e.turn_seq, e.block_state]).toEqual(['subagent', null, 'empty']);
  });

  it('V7b: a VS Code payload on pre-compact with no hippo.json records runtime claude-code and state empty', () => {
    const input = preCompactPayload('v7b', { transcript_path: writeVscodeTranscript(p) });
    const r = hippo(p, ['pre-compact'], { input });
    expect(r.status, r.stderr).toBe(0);
    const [e] = eventsN(p, 'v7b', 1);
    expect([e.event_type, e.runtime, e.block_state]).toEqual(['pre-compact', 'claude-code', 'empty']);
  });

  it('B12: a manual run records a row; the session comes from the environment, else it is missing and unnumbered', () => {
    saveSnapshot(p, null);
    const bare = hippo(p, ['compact-resume']);
    expect(bare.stdout).toContain(SNAPSHOT_TASK);
    expect(hippo(p, ['pre-compact']).status).toBe(0);
    const [resume, pre] = eventsN(p, null, 2);
    expect([resume.event_type, resume.block_state, resume.session_state, resume.turn_seq]).toEqual(['compact-resume', 'sent', 'missing', null]);
    expect([pre.event_type, pre.block_state, pre.session_state, pre.turn_seq]).toEqual(['pre-compact', 'empty', 'missing', null]);
    const env = { HIPPO_SESSION_ID: 'b12-env' };
    hippo(p, ['compact-resume'], { env });
    hippo(p, ['pre-compact'], { env });
    expect(eventsN(p, 'b12-env', 2).map((e) => [e.event_type, e.session_state, e.turn_seq])).toEqual([
      ['compact-resume', 'env', 1],
      ['pre-compact', 'env', 1],
    ]);
  });

  it('B7: one session in order shows the boundary rows between the prompt rows, numbered per type', () => {
    const transcript = writeTranscript(p);
    const steps: Array<[string[], string]> = [
      [PROMPT_HOOK, promptPayload('b7', 'first question about deploys')],
      [PROMPT_HOOK, promptPayload('b7', 'second question about the test suite')],
      [['pre-compact'], preCompactPayload('b7', { transcript_path: transcript, cwd: p.cwd })],
      [['compact-resume'], resumePayload('b7')],
      [PROMPT_HOOK, promptPayload('b7', 'third question about the release')],
    ];
    for (const [args, input] of steps) expect(hippo(p, args, { input }).status).toBe(0);
    const rows = eventsN(p, 'b7', 5);
    expect(rows.map((e) => [e.event_type, e.block_state, e.turn_seq])).toEqual([
      ['prompt-submit', 'sent', 1],
      ['prompt-submit', 'reused', 2],
      ['pre-compact', 'sent', 1],
      ['compact-resume', 'sent', 1],
      ['prompt-submit', 'sent', 3],
    ]);
  });
});

describe('B5: calls the hooks do not accept leave no row', () => {
  const IDLE_STDIN_ENV = { HIPPO_STDIN_WAIT_MS: '150' };

  function noRow(): void {
    expect(eventCount(p)).toBe(0);
  }

  it.each([
    ['source startup', 'compact-resume', resumePayload('b5', { source: 'startup' })],
    ['malformed stdin', 'compact-resume', '{not json'],
    ['malformed stdin', 'pre-compact', '{not json'],
  ])('%s on %s', (_label, hook, input) => {
    saveSnapshot(p, 'b5');
    expect(hippo(p, [hook], { input }).status).toBe(0);
    noRow();
  });

  it.each(['compact-resume', 'pre-compact'])('timed-out empty stdin on %s', async (hook) => {
    saveSnapshot(p, 'b5');
    const r = await hippoAsync(p, [hook], { input: null, env: IDLE_STDIN_ENV });
    expect([r.status, r.stdout]).toEqual([0, '']);
    noRow();
  });

  it.each([
    ['compact-resume', resumePayload('b5')],
    ['pre-compact', preCompactPayload('b5')],
  ])('a folder with no store on %s stays without a store', (hook, input) => {
    const bare = path.join(p.dir, 'bare');
    fs.mkdirSync(bare);
    expect(hippo(p, [hook], { input, cwd: bare }).status).toBe(0);
    expect(fs.existsSync(path.join(bare, '.hippo'))).toBe(false);
    expect(fs.existsSync(p.globalRoot)).toBe(false);
  });

  it('a VS Code payload with hippo.json present on pre-compact', () => {
    installCopilotHooksFile(p);
    const input = preCompactPayload('b5-vscode', { transcript_path: writeVscodeTranscript(p) });
    const r = hippo(p, ['pre-compact'], { input });
    expect([r.status, r.stdout]).toEqual([0, '']);
    noRow();
  });

  it.each([
    ['compact-resume', resumePayload('b5')],
    ['pre-compact', preCompactPayload('b5')],
  ])('the ledger flag off on %s', (hook, input) => {
    writeConfig(p, { ledger: false });
    saveSnapshot(p, 'b5');
    expect(hippo(p, [hook], { input }).status).toBe(0);
    noRow();
  });
});
