// What a PostToolUseFailure payload says, read with no store, so a hook with no store sends the same reading the local log keeps.
import { redactSecretsStrict } from '../secret-detect.js';
import { scrubForSharing } from '../share-scrub.js';
import { blockHash } from '../token-ledger.js';
import type { JsonValue } from '../json.js';

/** Why a failure was not stored, or `stored`. */
export type CaptureErrorOutcome = 'stored' | 'duplicate' | 'skipped-interrupt' | 'skipped-routine' | 'skipped-invalid';

/** Which routine check skipped a failure; the log keeps it so declines can be told apart from empty searches. */
export type RoutineRule = 'declined' | 'os-permission' | 'no-match' | 'search-tool' | 'quiet-exit';

/** What {@link lessonFromFailure} read from a payload; `detail` is the finer failure-log key (untruncated, command head). */
export type FailureReading =
  | { text: string; detail: string }
  | { skip: 'skipped-routine'; rule: RoutineRule; text: string; detail: string }
  | { skip: 'skipped-interrupt' | 'skipped-invalid'; text: null; detail: null };

/** The PostToolUseFailure payload fields this module reads. */
interface ToolFailurePayload {
  session_id?: JsonValue;
  tool_name?: JsonValue;
  error?: JsonValue;
  is_interrupt?: JsonValue;
  tool_input?: JsonValue;
}

/** The longest lesson text a reading gives, so a check of a sent one imports it instead of copying it. */
export const FAILURE_TEXT_MAX_CHARS = 200;

/** The user, a permission prompt or a hook said no: routine, not a lesson. */
const DECLINED = /user (?:doesn't|does not) want|denied by (?:the )?user|user (?:rejected|declined|denied)|permission to use|was blocked by (?:a )?hook/i;

/** The OS or a remote host refused access (EACCES, SSH publickey): routine too, but nobody declined anything. */
const OS_PERMISSION = /permission denied/i;

/** Leading `cd` or `pushd` steps say where a command ran, not what it ran. */
const LEADING_CD = /^\s*(?:(?:cd|pushd)\b[^;&|]*(?:&&|\|\||;)\s*)+/;

const NO_MATCH = /\bno (?:matches|files|results) found\b/i;

/** Shell commands whose exit code 1 means "nothing found" or "differs", not an error. */
const QUIET_EXIT_1 = /^\s*(?:grep|rg|egrep|fgrep|find|test|\[|diff|cmp|git diff|git grep)\b/;

function isString(v: JsonValue | undefined): v is string {
  return v !== undefined && v !== null && v.constructor === String;
}

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== undefined && v !== null && !Array.isArray(v) && v.constructor === Object;
}

/** A non-blank string field of the payload, or null. */
export function payloadString(payload: JsonValue, key: 'session_id' | 'tool_name'): string | null {
  if (!isObject(payload)) return null;
  const value = payload[key];
  return isString(value) && value.trim() !== '' ? value : null;
}

/** Normalised form used to spot repeats. The failure log keeps only its hash, so changing it breaks repeat counts. */
export function failureSignature(text: string): string {
  return text.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** The hash the failure log stores for a lesson text or a detail; one function so every writer counts repeats alike. */
export function failureHash(text: string): string {
  return blockHash(failureSignature(text));
}

/** The memory text for a failure payload, or why it is not stored; a routine skip keeps its text for the log. `scrub` runs before the cap, as a mask can be longer than what it hides. Pure. */
export function lessonFromFailure(payload: JsonValue, scrub: (text: string) => string = (text) => text): FailureReading {
  if (!isObject(payload)) return { skip: 'skipped-invalid', text: null, detail: null };
  // SAFETY: isObject narrowed payload to a plain JSON object; the fields read are all optional.
  const p = payload as ToolFailurePayload;
  if (p.is_interrupt === true) return { skip: 'skipped-interrupt', text: null, detail: null };
  if (!isString(p.error) || p.error.trim().length < 12) return { skip: 'skipped-invalid', text: null, detail: null };
  const tool = isString(p.tool_name) ? p.tool_name : 'tool';
  const error = redactSecretsStrict(p.error.replace(/\s+/g, ' ').trim());
  const text = scrub(`${tool}: ${error}`).slice(0, FAILURE_TEXT_MAX_CHARS);
  const command = isObject(p.tool_input) && isString(p.tool_input['command']) ? p.tool_input['command'].replace(LEADING_CD, '') : '';
  const head = command.trim().split(/\s+/).slice(0, 2).join(' ');
  const detail = `${tool}${head ? ` ${head}` : ''}: ${error}`;
  const routine = (rule: RoutineRule): FailureReading => ({ skip: 'skipped-routine', rule, text, detail });
  if (DECLINED.test(error)) return routine('declined');
  if (OS_PERMISSION.test(error)) return routine('os-permission');
  if (NO_MATCH.test(error)) return routine('no-match');
  if (tool === 'Grep' || tool === 'Glob') return routine('search-tool');
  if (tool === 'Bash' && QUIET_EXIT_1.test(command) && /exit code 1\b/i.test(error)) return routine('quiet-exit');
  return { text, detail };
}

/** A failure as it may leave the machine: the capped lesson text and the detail's hash, never the untruncated detail. */
export interface FailureReport {
  /** The payload's tool name; null when it named none. */
  tool: string | null;
  /** Scrubbed for sharing, then cut to at most 200 chars; null when the payload had no readable error. */
  text: string | null;
  /** Why it is not stored; null for a lesson. */
  skip: Exclude<CaptureErrorOutcome, 'stored' | 'duplicate'> | null;
  rule: RoutineRule | null;
  /** What the local failure log stores as `detail_hash` for the same payload. */
  detail_hash: string | null;
}

/** {@link lessonFromFailure} plus the detail's hash, for a writer whose store is elsewhere. Pure. */
export function failureReport(payload: JsonValue): FailureReport {
  const reading = lessonFromFailure(payload, scrubForSharing);
  return {
    tool: payloadString(payload, 'tool_name'),
    text: reading.text,
    skip: 'skip' in reading ? reading.skip : null,
    rule: 'rule' in reading ? reading.rule : null,
    detail_hash: reading.detail === null ? null : failureHash(reading.detail),
  };
}
