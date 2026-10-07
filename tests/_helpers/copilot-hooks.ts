// Copilot hook fixtures, and a scratch home whose COPILOT_HOME sits inside it so no test reads a real ~/.copilot.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonValue } from '../../src/json.js';
import { scratch, type Scratch } from './compaction-hooks.js';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'copilot');

export type CopilotPayloadName =
  | 'sessionStart'
  | 'SessionStart'
  | 'postToolUseFailureGrep'
  | 'postToolUseFailureBash'
  | 'postToolUseFailureBuild'
  | 'syntheticClaudeStyleTerminalFailure'
  | 'errorOccurred'
  | 'preCompact'
  | 'sessionEnd'
  | 'agentStop'
  | 'Stop'
  | 'PreCompact';

export interface CopilotScratch extends Scratch {
  copilotHome: string;
}

export function copilotScratch(): CopilotScratch {
  const s = scratch();
  const copilotHome = path.join(s.dir, '.copilot');
  // VS Code's folders too, so no hook run can read a real VS Code User folder.
  const vscodeFolders = { APPDATA: path.join(s.dir, 'appdata'), XDG_CONFIG_HOME: path.join(s.dir, 'xdg-config') };
  return { ...s, copilotHome, env: { ...s.env, COPILOT_HOME: copilotHome, ...vscodeFolders } };
}

/** One payload from hook-payloads.json as hook stdin text, with `<CWD>` and `<TRANSCRIPT>` set to real paths. */
export function copilotPayload(name: CopilotPayloadName, cwd: string, transcript = ''): string {
  const raw = fs.readFileSync(path.join(FIXTURES, 'hook-payloads.json'), 'utf8')
    .replaceAll('"<CWD>"', JSON.stringify(cwd))
    .replaceAll('"<TRANSCRIPT>"', JSON.stringify(transcript));
  // SAFETY: hook-payloads.json is an object keyed by every CopilotPayloadName.
  const all = JSON.parse(raw) as { [K in CopilotPayloadName]: JsonValue };
  return JSON.stringify(all[name]);
}

export const CLAUDE_SESSION = 'claude-sess-1';

/** A Claude Code hook payload in its documented snake_case fields, for the tests that keep Copilot handling off it. */
export function claudeCodePayload(event: 'PostToolUseFailure' | 'PreCompact' | 'SessionEnd', cwd: string, transcript: string): string {
  const common = { session_id: CLAUDE_SESSION, transcript_path: transcript, cwd, permission_mode: 'default', hook_event_name: event };
  if (event === 'PreCompact') return JSON.stringify({ ...common, trigger: 'auto', custom_instructions: '' });
  if (event === 'SessionEnd') return JSON.stringify({ ...common, reason: 'other' });
  return JSON.stringify({
    ...common,
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
    tool_use_id: 'toolu_01',
    error: 'Command failed with exit code 2: tsc reported TS2345 in src/auth/client.ts',
    is_interrupt: false,
  });
}

/** A Claude Code transcript of one user turn and one reply, written under `dir`. */
export function writeClaudeTranscript(dir: string): string {
  const file = path.join(dir, `${CLAUDE_SESSION}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'fix the flaky login test in auth.spec.ts' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The retry is fixed; the test run is next.' }] } },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

/** The Copilot event log fixture: VS Code's synthetic lines plus CLI sub-agent and injected-prompt lines. */
export function copilotEventsJsonl(): string {
  return fs.readFileSync(path.join(FIXTURES, 'events.jsonl'), 'utf8');
}

/** The event log from its second line on, cut mid-way through the first, as a tail read starting past the session.start line sees it. */
export function copilotEventsTail(): string {
  const text = copilotEventsJsonl();
  return text.slice(text.indexOf('\n') - 20);
}

/** Writes the event log where the Copilot CLI keeps it, `<COPILOT_HOME>/session-state/<id>/events.jsonl`. */
export function writeCopilotSessionLog(copilotHome: string, sessionId: string, text: string): string {
  const dir = path.join(copilotHome, 'session-state', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, text);
  return file;
}
