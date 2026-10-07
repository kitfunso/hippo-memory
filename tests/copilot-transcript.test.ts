// Copilot event logs read line by line: turns and working state from a tail, sub-agent and injected lines skipped, the CLI log found by id.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectSessionTurns } from '../src/capture/transcript.js';
import { transcriptWorkingState } from '../src/capture/working-state.js';
import { copilotTranscriptFor, copilotTurn } from '../src/capture/copilot-transcript.js';
import { copilotEventsJsonl, copilotEventsTail, writeCopilotSessionLog } from './_helpers/copilot-hooks.js';

const TASK = 'fix the flaky login test in auth.spec.ts';
const DECISION = 'We decided to keep the retry budget at three attempts for the login client. Next I will rerun the auth suite.';

let dir: string;
const origCopilotHome = process.env.COPILOT_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-copilot-transcript-'));
  process.env.COPILOT_HOME = path.join(dir, '.copilot');
});

afterEach(() => {
  if (origCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = origCopilotHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a Copilot events.jsonl tail with no first line (critic test 4)', () => {
  // events.jsonl: VS Code's sessionTranscriptService.ts line format (scratchpad copilot-details 1a), plus copilot-sdk streaming-events.md's agentId.
  it('gives the human and main-agent turns from a tail that starts mid-line', () => {
    expect(collectSessionTurns(copilotEventsTail())).toEqual([
      { role: 'user', text: TASK },
      { role: 'assistant', text: 'Looking at the login client first.' },
      { role: 'assistant', text: DECISION },
    ]);
  });

  it('gives a working state whose task and next step skip the injected and sub-agent lines after them', () => {
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, copilotEventsTail());
    const logged: string[] = [];
    const state = transcriptWorkingState(file, (m) => logged.push(m));
    expect(logged).toEqual([]);
    expect(state).not.toBeNull();
    expect(state?.task).toBe(TASK);
    expect(state?.next_step).toBe(DECISION);
    expect(state?.summary).toContain(DECISION);
    expect(state?.summary).not.toContain('Sub-agent report');
    expect(state?.summary).not.toContain('pdf skill');
  });

  it('reads the whole log the same way', () => {
    expect(collectSessionTurns(copilotEventsJsonl())).toEqual(collectSessionTurns(copilotEventsTail()));
  });
});

describe('copilotTurn', () => {
  it('skips a sub-agent line by agentId or by the deprecated parentToolCallId', () => {
    expect(copilotTurn({ type: 'assistant.message', data: { content: 'x' }, agentId: 'explore-1' })).toBeNull();
    expect(copilotTurn({ type: 'assistant.message', data: { content: 'x', parentToolCallId: 'call_2' } })).toBeNull();
    expect(copilotTurn({ type: 'assistant.message', data: { content: 'x' }, agentId: '' })).toEqual({ role: 'assistant', text: 'x' });
  });

  it('skips a user message a skill, another agent or autopilot wrote', () => {
    for (const data of [{ content: 'x', source: 'skill-pdf' }, { content: 'x', source: 'agent-42' }, { content: 'x', isAutopilotContinuation: true }]) {
      expect(copilotTurn({ type: 'user.message', data })).toBeNull();
    }
    expect(copilotTurn({ type: 'user.message', data: { content: ' x ', source: 'user' } })).toEqual({ role: 'user', text: 'x' });
  });

  it('gives nothing for other event types, blank content or a missing data object', () => {
    expect(copilotTurn({ type: 'tool.execution_complete', data: { content: 'x' } })).toBeNull();
    expect(copilotTurn({ type: 'assistant.message', data: { content: '   ' } })).toBeNull();
    expect(copilotTurn({ type: 'user.message' })).toBeNull();
    expect(copilotTurn({ type: 'user', data: { content: 'x' } })).toBeNull();
  });
});

describe('copilotTranscriptFor', () => {
  it('finds <COPILOT_HOME>/session-state/<id>/events.jsonl', () => {
    const file = writeCopilotSessionLog(path.join(dir, '.copilot'), 'copilot-sess-1', copilotEventsJsonl());
    expect(copilotTranscriptFor('copilot-sess-1')).toBe(file);
  });

  it('gives null for a missing log or an id that could leave session-state', () => {
    writeCopilotSessionLog(path.join(dir, '.copilot'), 'copilot-sess-1', copilotEventsJsonl());
    expect(copilotTranscriptFor('other-session')).toBeNull();
    for (const id of ['..', '../copilot-sess-1', 'a/b', 'a\\b', '']) expect(copilotTranscriptFor(id)).toBeNull();
  });
});
