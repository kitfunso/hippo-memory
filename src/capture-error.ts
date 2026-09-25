// `hippo capture-error`, run by the Claude Code PostToolUseFailure hook: routine failures and repeats are not
// stored, because error memories decay slowly and would crowd out real lessons; what is stored stays `observed`
// until outcome feedback confirms it. Every failure, stored or not, goes to the failure log (ROADMAP CD13).
import { createMemory, type MemoryEntry } from './memory.js';
import { writeEntry, loadAllEntries } from './store.js';
import { loadConfig } from './config.js';
import { closeHippoDb, openHippoDb } from './db.js';
import { recordFailure, type FailureOutcome } from './failure-log.js';
import { blockHash } from './token-ledger.js';
import type { JsonValue } from './working-memory.js';

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

const MAX_LEN = 200;

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

function payloadString(payload: JsonValue, key: 'session_id' | 'tool_name'): string | null {
  if (!isObject(payload)) return null;
  const value = payload[key];
  return isString(value) && value.trim() !== '' ? value : null;
}

/** Normalised form used to spot repeats. The failure log keeps only its hash, so changing it breaks repeat counts. */
export function failureSignature(text: string): string {
  return text.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** The memory text for a failure payload, or why it is not stored; a routine skip keeps its text for the log. Pure. */
export function lessonFromFailure(payload: JsonValue): FailureReading {
  if (!isObject(payload)) return { skip: 'skipped-invalid', text: null, detail: null };
  // SAFETY: isObject narrowed payload to a plain JSON object; the fields read are all optional.
  const p = payload as ToolFailurePayload;
  if (p.is_interrupt === true) return { skip: 'skipped-interrupt', text: null, detail: null };
  if (!isString(p.error) || p.error.trim().length < 12) return { skip: 'skipped-invalid', text: null, detail: null };
  const tool = isString(p.tool_name) ? p.tool_name : 'tool';
  const error = p.error.replace(/\s+/g, ' ').trim();
  const text = `${tool}: ${error}`.slice(0, MAX_LEN);
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

/** Store a failure as an error memory unless it is routine or a repeat, and log it either way, even when storing throws. */
export function captureToolFailure(hippoRoot: string, tenantId: string, payload: JsonValue): CaptureErrorOutcome {
  const lesson = lessonFromFailure(payload);
  let outcome: FailureOutcome = 'store-failed';
  try {
    outcome = 'skip' in lesson ? lesson.skip : storeLesson(hippoRoot, tenantId, lesson.text);
    return outcome;
  } finally {
    logFailure(hippoRoot, tenantId, payload, lesson, outcome);
  }
}

function logFailure(hippoRoot: string, tenantId: string, payload: JsonValue, lesson: FailureReading, outcome: FailureOutcome): void {
  const hash = (s: string | null): string | null => (s === null ? null : blockHash(failureSignature(s)));
  const db = openHippoDb(hippoRoot);
  try {
    recordFailure(db, {
      tenantId,
      sessionId: payloadString(payload, 'session_id'),
      tool: payloadString(payload, 'tool_name'),
      outcome,
      rule: 'rule' in lesson ? lesson.rule : null,
      sigHash: hash(lesson.text),
      detailHash: hash(lesson.detail),
    });
  } finally {
    closeHippoDb(db);
  }
}

function storeLesson(hippoRoot: string, tenantId: string, text: string): 'stored' | 'duplicate' {
  const sig = failureSignature(text);
  const repeat = loadAllEntries(hippoRoot, tenantId).some(
    (e: MemoryEntry) => e.tags.includes('auto-captured') && failureSignature(e.content) === sig,
  );
  if (repeat) return 'duplicate';
  const entry = createMemory(text, {
    tags: ['error', 'auto-captured'],
    source: 'tool-failure',
    confidence: 'observed',
    tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
  });
  writeEntry(hippoRoot, entry);
  return 'stored';
}
