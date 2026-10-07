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
  | 'PostToolUseFailureTerminal'
  | 'errorOccurred'
  | 'preCompact'
  | 'sessionEnd';

export interface CopilotScratch extends Scratch {
  copilotHome: string;
}

export function copilotScratch(): CopilotScratch {
  const s = scratch();
  const copilotHome = path.join(s.dir, '.copilot');
  return { ...s, copilotHome, env: { ...s.env, COPILOT_HOME: copilotHome } };
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
