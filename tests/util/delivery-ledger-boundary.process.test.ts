// The boundary hooks through the built CLI, compaction and session end: which delivery_events row each one leaves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blockHash, estimateTokens } from '../../src/base/util/token-text.js';
import { DELIVERY_LEDGER_VERSION } from '../../src/base/session/delivery.js';
import { copilotPayload } from '../_helpers/copilot-hooks.js';
import {
  PROMPT_HOOK,
  SNAPSHOT_TASK,
  dispose,
  eventCount,
  eventsN,
  hippo,
  hippoAsync,
  hippoIn,
  hippoInNoWorker,
  hippoNoWorker,
  installCopilotHooksFile,
  preCompactPayload,
  project,
  promptPayload,
  resumePayload,
  saveSnapshot,
  sessionEndPayload,
  tableRows,
  writeConfig,
  writeTranscript,
  writeVscodeTranscript,
  type Project,
} from '../_helpers/delivery-boundary.js';

let p: Project;

beforeEach(() => {
  p = project();
});

afterEach(() => {
  dispose(p);
});

describe('what one boundary hook call records', () => {
  // B1, B3 and E1 stay spawned: each pins one hook verb end to end in a real child; the rest run in process.
  it('a Claude Code PreCompact payload leaves one sent row priced on the summariser text', () => {
    const r = hippo(p, ['pre-compact'], { input: preCompactPayload('b1') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toBe('');
    const [e] = eventsN(p, 'b1', 1);
    expect([e.event_type, e.runtime, e.surface, e.session_state, e.turn_seq, e.block_state, e.ledger_version]).toEqual([
      'pre-compact',
      'claude-code',
      'hook',
      'payload',
      1,
      'sent',
      DELIVERY_LEDGER_VERSION,
    ]);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
    expect([e.candidates, e.considered_count, e.emitted_count, e.rejected_count]).toEqual([[], 0, 0, 0]);
  });

  it('compact-resume with a fresh snapshot of the same session leaves one sent row and its token-ledger row', () => {
    saveSnapshot(p, 'b3');
    const r = hippo(p, ['compact-resume'], { input: resumePayload('b3') });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(SNAPSHOT_TASK);
    const [e] = eventsN(p, 'b3', 1);
    expect([e.event_type, e.session_state, e.turn_seq, e.block_state]).toEqual([
      'compact-resume',
      'payload',
      1,
      'sent',
    ]);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
    expect(
      tableRows(p, `SELECT event FROM token_ledger WHERE surface = 'compact_resume' AND session_id = 'b3'`),
    ).toHaveLength(1);
  });

  it('pre-compact --runtime copilot leaves one empty row with runtime copilot and prints nothing', async () => {
    const payload = copilotPayload('preCompact', p.cwd, 'no-such-transcript.jsonl');
    const r = await hippoIn(p, ['pre-compact', '--runtime', 'copilot'], { input: payload });
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'copilot-sess-1', 1);
    expect([e.event_type, e.runtime, e.block_state, e.emitted_hash, e.injected_tokens]).toEqual([
      'pre-compact',
      'copilot',
      'empty',
      null,
      0,
    ]);
  });

  it('compact-resume records empty without a snapshot, empty for another session, disabled in the holdout arm', async () => {
    expect((await hippoIn(p, ['compact-resume'], { input: resumePayload('b4-none') })).stdout).toBe('');
    saveSnapshot(p, 'other-session');
    expect((await hippoIn(p, ['compact-resume'], { input: resumePayload('b4-mismatch') })).stdout).toBe('');
    writeConfig(p, { holdout: true });
    saveSnapshot(p, 'b4-holdout');
    expect((await hippoIn(p, ['compact-resume'], { input: resumePayload('b4-holdout') })).stdout).toBe('');
    expect([
      eventsN(p, 'b4-none', 1)[0].block_state,
      eventsN(p, 'b4-mismatch', 1)[0].block_state,
      eventsN(p, 'b4-holdout', 1)[0].block_state,
    ]).toEqual(['empty', 'empty', 'disabled']);
  });

  it('a sub-agent payload leaves one subagent row with no turn number, on both hooks', async () => {
    saveSnapshot(p, 'b6');
    const resume = await hippoIn(p, ['compact-resume'], { input: resumePayload('b6', { agent_id: 'agent-1' }) });
    const pre = await hippoIn(p, ['pre-compact'], { input: preCompactPayload('b6', { agent_id: 'agent-1' }) });
    expect([resume.status, resume.stdout]).toEqual([0, '']);
    expect(pre.status).toBe(0);
    const rows = eventsN(p, 'b6', 2);
    expect(rows.map((e) => [e.event_type, e.session_state, e.turn_seq, e.block_state])).toEqual([
      ['compact-resume', 'subagent', null, 'empty'],
      ['pre-compact', 'subagent', null, 'sent'],
    ]);
  });

  it('a sub-agent payload on compact-resume in a holdout session records empty, not disabled', async () => {
    writeConfig(p, { holdout: true });
    saveSnapshot(p, 'v6');
    const r = await hippoIn(p, ['compact-resume'], { input: resumePayload('v6', { agent_id: 'agent-1' }) });
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'v6', 1);
    expect([e.session_state, e.turn_seq, e.block_state]).toEqual(['subagent', null, 'empty']);
  });

  it('a VS Code payload on pre-compact with no hippo.json records runtime claude-code and state empty', async () => {
    const input = preCompactPayload('v7b', { transcript_path: writeVscodeTranscript(p) });
    const r = await hippoIn(p, ['pre-compact'], { input });
    expect(r.status, r.stderr).toBe(0);
    const [e] = eventsN(p, 'v7b', 1);
    expect([e.event_type, e.runtime, e.block_state]).toEqual(['pre-compact', 'claude-code', 'empty']);
  });

  it('a manual run records a row; the session comes from the environment, else it is missing and unnumbered', async () => {
    saveSnapshot(p, null);
    const bare = await hippoIn(p, ['compact-resume']);
    expect(bare.stdout).toContain(SNAPSHOT_TASK);
    expect((await hippoIn(p, ['pre-compact'])).status).toBe(0);
    const [resume, pre] = eventsN(p, null, 2);
    expect([resume.event_type, resume.block_state, resume.session_state, resume.turn_seq]).toEqual([
      'compact-resume',
      'sent',
      'missing',
      null,
    ]);
    expect([pre.event_type, pre.block_state, pre.session_state, pre.turn_seq]).toEqual([
      'pre-compact',
      'empty',
      'missing',
      null,
    ]);
    const env = { HIPPO_SESSION_ID: 'b12-env' };
    await hippoIn(p, ['compact-resume'], { env });
    await hippoIn(p, ['pre-compact'], { env });
    expect(eventsN(p, 'b12-env', 2).map((e) => [e.event_type, e.session_state, e.turn_seq])).toEqual([
      ['compact-resume', 'env', 1],
      ['pre-compact', 'env', 1],
    ]);
  });

  it('one session in order shows the boundary and context rows between the prompt rows, numbered per type', async () => {
    const transcript = writeTranscript(p);
    const steps: Array<[string[], string]> = [
      [PROMPT_HOOK, promptPayload('b7', 'first question about deploys')],
      [PROMPT_HOOK, promptPayload('b7', 'second question about the test suite')],
      [['pre-compact'], preCompactPayload('b7', { transcript_path: transcript, cwd: p.cwd })],
      [['compact-resume'], resumePayload('b7')],
      [PROMPT_HOOK, promptPayload('b7', 'third question about the release')],
    ];
    for (const [args, input] of steps) expect((await hippoIn(p, args, { input })).status).toBe(0);
    // An agent's own `hippo context` run takes the session from the environment Claude Code gives its shell.
    expect((await hippoIn(p, ['context', 'rollback', 'plan'], { env: { CLAUDE_CODE_SESSION_ID: 'b7' } })).status).toBe(
      0,
    );
    expect((await hippoInNoWorker(p, ['session-end'], { input: sessionEndPayload('b7') })).status).toBe(0);
    const rows = eventsN(p, 'b7', 7);
    expect(rows.map((e) => [e.event_type, e.block_state, e.turn_seq])).toEqual([
      ['prompt-submit', 'sent', 1],
      ['prompt-submit', 'reused', 2],
      ['pre-compact', 'sent', 1],
      ['compact-resume', 'sent', 1],
      ['prompt-submit', 'sent', 3],
      ['context', 'sent', 1],
      ['session-end', 'empty', 1],
    ]);
  });
});

describe('the ledger changes nothing session-end prints or exits with', () => {
  let off: Project;

  beforeEach(() => {
    off = project({ ledger: false });
  });

  afterEach(() => {
    dispose(off);
  });

  // B9 in delivery-ledger-boundary-faults.process.test.ts holds the same off-and-on check for pre-compact and compact-resume.
  it('session-end gives the same stdout and status off and on', async () => {
    const on = await hippoInNoWorker(p, ['session-end'], { input: sessionEndPayload('i3') });
    const plain = await hippoInNoWorker(off, ['session-end'], { input: sessionEndPayload('i3') });
    expect([on.status, plain.status], `${on.stderr}${plain.stderr}`).toEqual([0, 0]);
    expect(on.stdout).toBe(plain.stdout);
    expect(eventsN(p, 'i3', 1).map((e) => e.event_type)).toEqual(['session-end']);
    expect(eventCount(off)).toBe(0);
  });
});

describe('what one session-end hook call records', () => {
  it('a Claude Code SessionEnd payload leaves one empty boundary row and prints nothing', () => {
    const r = hippoNoWorker(p, ['session-end'], { input: sessionEndPayload('e1') });
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'e1', 1);
    expect([e.event_type, e.runtime, e.surface, e.session_state, e.turn_seq, e.block_state, e.ledger_version]).toEqual([
      'session-end',
      'claude-code',
      'hook',
      'payload',
      1,
      'empty',
      DELIVERY_LEDGER_VERSION,
    ]);
    expect([e.emitted_hash, e.injected_tokens, e.prompt_hash, e.query_hash, e.recall_trace_id, e.candidates]).toEqual([
      null,
      0,
      null,
      null,
      null,
      [],
    ]);
  });

  it('a second fire inside the window is a duplicate of the first', async () => {
    for (let i = 0; i < 2; i++) {
      expect((await hippoInNoWorker(p, ['session-end'], { input: sessionEndPayload('e2') })).status).toBe(0);
    }
    const [first, second] = eventsN(p, 'e2', 2);
    expect([first.turn_seq, first.duplicate_of, second.turn_seq, second.duplicate_of]).toEqual([
      1,
      null,
      null,
      first.id,
    ]);
  });

  it('a Copilot sessionEnd run from another folder records runtime copilot in the payload folder store', async () => {
    const r = await hippoInNoWorker(p, ['session-end', '--runtime', 'copilot'], {
      input: copilotPayload('sessionEnd', p.cwd),
      cwd: p.dir,
    });
    expect(r.status, r.stderr).toBe(0);
    const [e] = eventsN(p, 'copilot-sess-1', 1);
    expect([e.event_type, e.runtime, e.session_state, e.block_state]).toEqual([
      'session-end',
      'copilot',
      'payload',
      'empty',
    ]);
  });

  it('a manual run, a malformed payload, a turn end and a ledger switched off leave no row', async () => {
    expect((await hippoInNoWorker(p, ['session-end'])).status).toBe(0);
    expect((await hippoInNoWorker(p, ['session-end'], { input: 'not json' })).status).toBe(0);
    // A VS Code Stop payload, the one turn mode accepts, so the call reaches the recorder's turn check.
    expect(
      (
        await hippoInNoWorker(p, ['session-end', '--turn'], {
          input: sessionEndPayload('e4-turn', { hook_event_name: 'Stop' }),
        })
      ).status,
    ).toBe(0);
    writeConfig(p, { ledger: false });
    expect((await hippoInNoWorker(p, ['session-end'], { input: sessionEndPayload('e4-off') })).status).toBe(0);
    expect(eventCount(p)).toBe(0);
  });
});

describe('calls the hooks do not accept leave no row', () => {
  const IDLE_STDIN_ENV = { HIPPO_STDIN_WAIT_MS: '150' };

  function noRow(): void {
    expect(eventCount(p)).toBe(0);
  }

  it.each([
    ['source startup', 'compact-resume', resumePayload('b5', { source: 'startup' })],
    ['malformed stdin', 'compact-resume', '{not json'],
    ['malformed stdin', 'pre-compact', '{not json'],
  ])('%s on %s', async (_label, hook, input) => {
    saveSnapshot(p, 'b5');
    expect((await hippoIn(p, [hook], { input })).status).toBe(0);
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
  ])('a folder with no store on %s stays without a store', async (hook, input) => {
    const bare = path.join(p.dir, 'bare');
    fs.mkdirSync(bare);
    expect((await hippoIn(p, [hook], { input, cwd: bare })).status).toBe(0);
    expect(fs.existsSync(path.join(bare, '.hippo'))).toBe(false);
    expect(fs.existsSync(p.globalRoot)).toBe(false);
  });

  it('a VS Code payload with hippo.json present on pre-compact', async () => {
    installCopilotHooksFile(p);
    const input = preCompactPayload('b5-vscode', { transcript_path: writeVscodeTranscript(p) });
    const r = await hippoIn(p, ['pre-compact'], { input });
    expect([r.status, r.stdout]).toEqual([0, '']);
    noRow();
  });
});
