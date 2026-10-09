import { envStdinWaitMs } from '../util/env.js';
import { isJsonString, type JsonValue, isJsonObjectLiteral } from '../util/json.js';
import type { JsonObject } from '../store/working-memory.js';

const DEFAULT_STDIN_WAIT_MS = 1000;

/** `timedOut` means the window closed with stdin still open, so absent
 * `text` is "unknown", not "none", and present `text` may be truncated.
 * Treating absence as a manual run is only safe when it is false. */
export interface BoundedStdin { text?: string; timedOut: boolean; }

function defaultWaitMs(): number {
  return envStdinWaitMs() ?? DEFAULT_STDIN_WAIT_MS;
}

/** Never blocks: a TTY resolves at once, otherwise waits up to `waitMs` of
 * idle (default 1000ms, or `HIPPO_STDIN_WAIT_MS`), refreshed on each chunk
 * so a slow but real write is not cut off, and capped at `waitMs * 10`. */
export function readStdinBounded(waitMs: number = defaultWaitMs()): Promise<BoundedStdin> {
  let stdin: NodeJS.ReadStream;
  try {
    stdin = process.stdin;
  } catch {
    // Reading process.stdin can throw when the handle is closed; that is the same as no input.
    return Promise.resolve({ timedOut: false });
  }
  if (stdin.isTTY) return Promise.resolve({ timedOut: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (timedOut: boolean): void => {
      clearTimeout(timer); clearTimeout(hardCap);
      stdin.off('data', onData); stdin.off('end', done); stdin.off('error', done);
      stdin.pause();
      stdin.unref?.();
      resolve({ text: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined, timedOut });
    };
    const done = (): void => finish(false);
    const onData = (c: Buffer): void => { chunks.push(c); timer.refresh(); };
    const timer = setTimeout(() => finish(true), waitMs);
    // The idle timer refreshes per chunk, so a host that dribbles bytes
    // forever without ending would never resolve without this ceiling.
    const hardCap = setTimeout(() => finish(true), waitMs * 10);
    stdin.on('data', onData); stdin.once('end', done); stdin.once('error', done);
  });
}

// The Copilot harness's camelCase hook fields and the snake_case keys every hippo payload reader looks up.
const CAMEL_TO_SNAKE: ReadonlyArray<readonly [string, string]> = [
  ['sessionId', 'session_id'],
  ['transcriptPath', 'transcript_path'],
  ['toolName', 'tool_name'],
  ['hookEventName', 'hook_event_name'],
  ['customInstructions', 'custom_instructions'],
];

/** Copilot sends `toolArgs` as the model's raw JSON string; Claude Code and VS Code send `tool_input` already parsed. */
function parsedToolArgs(value: JsonValue): JsonValue {
  if (!isJsonString(value)) return value;
  try {
    // SAFETY: JSON.parse returns a JSON value by definition.
    return JSON.parse(value) as JsonValue;
  } catch {
    // Arguments that are not JSON stay the string the model wrote.
    return value;
  }
}

/** The snake_case keys a payload lacks, filled from its camelCase twins; a snake_case key already present wins. */
function snakeCaseFields(payload: JsonObject): JsonObject {
  const added: JsonObject = {};
  for (const [camel, snake] of CAMEL_TO_SNAKE) {
    if (camel in payload && !(snake in payload)) added[snake] = payload[camel];
  }
  if ('toolArgs' in payload && !('tool_input' in payload)) added.tool_input = parsedToolArgs(payload.toolArgs);
  const error = payload.error;
  // An error object gives its message, so readers that expect the documented string still get one.
  if (isJsonObjectLiteral(error) && isJsonString(error.message)) added.error = error.message;
  return added;
}

/** A hook payload with Copilot's camelCase fields copied to the snake_case keys hippo reads. The camelCase keys stay,
 * so the sessionStart reply can follow the sender's casing; text that needs no change comes back exactly as sent. */
export function normaliseHookPayload(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return text;
  let payload: JsonValue;
  try {
    // SAFETY: JSON.parse returns a JSON value by definition.
    payload = JSON.parse(text.trim()) as JsonValue;
  } catch {
    // Not JSON: each reader already treats that as a malformed payload, so it passes through untouched.
    return text;
  }
  if (!isJsonObjectLiteral(payload)) return text;
  const added = snakeCaseFields(payload);
  return Object.keys(added).length === 0 ? text : JSON.stringify({ ...payload, ...added });
}

/** The stdin read every hook verb uses: {@link readStdinBounded}, with the payload passed through {@link normaliseHookPayload}. */
export async function readHookStdin(waitMs?: number): Promise<BoundedStdin> {
  const read = await readStdinBounded(waitMs);
  return { text: normaliseHookPayload(read.text), timedOut: read.timedOut };
}
