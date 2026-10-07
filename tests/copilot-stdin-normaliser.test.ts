// normaliseHookPayload gives every hook reader the snake_case keys it looks up, from a Copilot payload, and leaves Claude Code's alone.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { normaliseHookPayload } from '../src/stdin.js';
import { hookPayloadSessionId } from '../src/token-ledger.js';
import { createDeliveryRecorder, type DeliveryEventInput, type DeliveryRuntime } from '../src/delivery-recorder.js';
import { readClaudeCodePreCompact } from '../src/capture-contract.js';
import { lessonFromFailure, payloadString } from '../src/capture/failure-reading.js';
import type { JsonValue } from '../src/json.js';
import { copilotPayload } from './_helpers/copilot-hooks.js';

const CWD = 'C:\\Users\\user\\proj';
const TRANSCRIPT = 'C:\\Users\\user\\.copilot\\session-state\\copilot-sess-1\\events.jsonl';
const CLAUDE_FIXTURE = path.resolve(__dirname, 'fixtures', 'compaction', 'post-compact-payloads.jsonl');

function normalised(text: string): JsonValue {
  const out = normaliseHookPayload(text);
  if (out === undefined) throw new Error('normaliser dropped the payload');
  // SAFETY: JSON.parse returns a JSON value by definition.
  return JSON.parse(out) as JsonValue;
}

function deliveryEvent(stdinText: string | undefined, runtime?: DeliveryRuntime): DeliveryEventInput {
  const rec = createDeliveryRecorder({ root: CWD, storeHash: 'aaaaaaaaaaaaaaaa', writeStore: 'local', tenantId: 'default', stdinText, runtime });
  let input: DeliveryEventInput | null = null;
  rec.flush((i) => { input = i; return 1; });
  if (input === null) throw new Error('recorder wrote nothing');
  return input;
}

describe('normaliseHookPayload on Copilot camelCase payloads', () => {
  // Payloads from docs.github.com/en/copilot/reference/hooks-reference, "Hook event input payloads", camelCase format.
  it('maps postToolUseFailure fields and parses the toolArgs JSON string (GH hooks reference and the use-hooks guide sample)', () => {
    expect(normalised(copilotPayload('postToolUseFailureBash', CWD))).toEqual({
      sessionId: 'copilot-sess-1',
      timestamp: 1791374470000,
      cwd: CWD,
      toolName: 'bash',
      toolArgs: '{"command":"grep -rn retryBudget src"}',
      error: 'Command failed with exit code 1',
      session_id: 'copilot-sess-1',
      tool_name: 'bash',
      tool_input: { command: 'grep -rn retryBudget src' },
    });
  });

  it('maps preCompact transcriptPath and customInstructions', () => {
    const p = normalised(copilotPayload('preCompact', CWD, TRANSCRIPT));
    expect(p).toMatchObject({ session_id: 'copilot-sess-1', transcript_path: TRANSCRIPT, custom_instructions: '', trigger: 'auto' });
  });

  it('maps hookEventName', () => {
    expect(normalised(JSON.stringify({ sessionId: 's', hookEventName: 'SessionStart' }))).toMatchObject({ hook_event_name: 'SessionStart' });
  });

  it('keeps toolArgs that are not JSON as the string the model wrote', () => {
    expect(normalised(JSON.stringify({ sessionId: 's', toolName: 'bash', toolArgs: 'ls -la' }))).toMatchObject({ tool_input: 'ls -la' });
  });

  it('keeps toolArgs that are already an object', () => {
    expect(normalised(JSON.stringify({ sessionId: 's', toolArgs: { command: 'ls' } }))).toMatchObject({ tool_input: { command: 'ls' } });
  });

  it('gives an error object its message, as errorOccurred sends one', () => {
    expect(normalised(copilotPayload('errorOccurred', CWD))).toMatchObject({ error: 'Model request timed out after 60s' });
  });

  it('keeps a string error as it is', () => {
    expect(normalised(copilotPayload('postToolUseFailureGrep', CWD))).toMatchObject({ error: 'rg: src/auth: IO error for operation on src/auth' });
  });

  it('lets a snake_case key already present win over its camelCase twin', () => {
    const text = JSON.stringify({ sessionId: 'camel', session_id: 'snake', toolArgs: '{"a":1}', tool_input: { b: 2 }, toolName: 'x', tool_name: 'y' });
    expect(normalised(text)).toMatchObject({ session_id: 'snake', tool_input: { b: 2 }, tool_name: 'y' });
  });
});

describe('normaliseHookPayload leaves other payloads untouched', () => {
  // Five real Claude Code PostCompact payloads, the same fixture compaction-items.test.ts reads.
  it('returns each Claude Code payload byte for byte', () => {
    const lines = fs.readFileSync(CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(normaliseHookPayload(line)).toBe(line);
  });

  it('returns a VS Code snake_case payload byte for byte', () => {
    const text = copilotPayload('SessionStart', CWD);
    expect(normaliseHookPayload(text)).toBe(text);
  });

  it('passes empty, non-JSON and non-object text through', () => {
    for (const text of [undefined, '', '  \n', 'not json', '[1,2]', 'null', '"s"']) {
      expect(normaliseHookPayload(text)).toBe(text);
    }
  });
});

describe('every payload reader sees session_id and the copilot runtime (critic test 3)', () => {
  it('the token ledger reads the session id', () => {
    const text = normaliseHookPayload(copilotPayload('sessionStart', CWD));
    expect(hookPayloadSessionId(text)).toBe('copilot-sess-1');
    expect(hookPayloadSessionId(copilotPayload('sessionStart', CWD))).toBeNull();
  });

  it('the delivery recorder writes the session id and the runtime the flag set', () => {
    const camel = deliveryEvent(normaliseHookPayload(copilotPayload('sessionStart', CWD)), 'copilot');
    expect(camel).toMatchObject({ sessionId: 'copilot-sess-1', sessionState: 'payload', runtime: 'copilot' });
    const snake = copilotPayload('SessionStart', CWD);
    // VS Code sends hook_event_name, so without the flag the recorder would book a Copilot call as Claude Code.
    expect(deliveryEvent(snake).runtime).toBe('claude-code');
    expect(deliveryEvent(snake, 'copilot')).toMatchObject({ sessionId: 'vscode-sess-1', runtime: 'copilot' });
  });

  it('the PreCompact reader takes the Copilot payload with runtime copilot', () => {
    const receipt = readClaudeCodePreCompact(normaliseHookPayload(copilotPayload('preCompact', CWD, TRANSCRIPT)), false, 'copilot');
    expect(receipt).toEqual({
      status: 'received',
      input: { runtime: 'copilot', event: 'pre-compact', manual: false, sessionId: 'copilot-sess-1', cwd: CWD, transcriptPath: TRANSCRIPT, trigger: 'auto' },
    });
  });

  it('the failure reader sees the session, the tool and the parsed command', () => {
    const payload = normalised(copilotPayload('postToolUseFailureBash', CWD));
    expect(payloadString(payload, 'session_id')).toBe('copilot-sess-1');
    expect(payloadString(payload, 'tool_name')).toBe('bash');
    expect(lessonFromFailure(payload)).toMatchObject({ skip: 'skipped-routine', rule: 'quiet-exit', detail: 'bash grep -rn: Command failed with exit code 1' });
  });
});
