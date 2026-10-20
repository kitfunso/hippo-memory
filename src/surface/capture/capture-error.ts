// `hippo capture-error`, run by the Claude Code PostToolUseFailure hook: routine failures and repeats are not stored,
// because error memories decay slowly and would crowd out real lessons; what is stored stays `observed` until outcome
// feedback confirms it. Every failure, stored or not, goes to the failure log.
import type { Context } from '../../api/types.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { createMemory } from '../../base/memory/memory.js';
import {
  failureHash,
  failureSignature,
  lessonFromFailure,
  payloadString,
  type FailureReading,
} from './failure-reading.js';
import type { JsonValue } from '../../base/util/json.js';
import type { CaptureErrorOutcome, FailureOutcome } from '../../store/port/failure-log.js';

/** The store a failure is logged and its lesson kept in, with that store's config. */
export type FailureTarget = Pick<Context, 'tenantId' | 'store' | 'config'>;

/**
 * Store a failure as an error memory unless it is routine or a repeat, and log it either way, even when storing throws.
 */
export async function captureToolFailure(
  target: FailureTarget,
  payload: JsonValue,
  onLogged?: (failureId: number | null) => void,
): Promise<CaptureErrorOutcome> {
  const lesson = lessonFromFailure(payload);
  let outcome: FailureOutcome = 'store-failed';
  try {
    outcome = 'skip' in lesson ? lesson.skip : await storeLesson(target, lesson.text);
    return outcome;
  } finally {
    await logAndReport(target, payload, lesson, outcome, onLogged);
  }
}

/** Logs the failure, then tells the caller the row id, or null when the write threw; the throw goes on. */
async function logAndReport(
  target: FailureTarget,
  payload: JsonValue,
  lesson: FailureReading,
  outcome: FailureOutcome,
  onLogged: ((failureId: number | null) => void) | undefined,
): Promise<void> {
  let id: number;
  try {
    id = await logFailure(target, payload, lesson, outcome);
  } catch (error) {
    onLogged?.(null);
    throw error;
  }
  onLogged?.(id);
}

function logFailure(
  { store, tenantId }: FailureTarget,
  payload: JsonValue,
  lesson: FailureReading,
  outcome: FailureOutcome,
): Promise<number> {
  const hash = (s: string | null): string | null => (s === null ? null : failureHash(s));
  return store.failureLog.record({
    tenantId,
    sessionId: payloadString(payload, 'session_id'),
    tool: payloadString(payload, 'tool_name'),
    outcome,
    rule: 'rule' in lesson ? lesson.rule : null,
    sigHash: hash(lesson.text),
    detailHash: hash(lesson.detail),
  });
}

/** Who sent a failure from another machine: the audit actor and the project its lesson and repeat check belong to. */
export interface LessonCaller {
  actor: string;
  originProject: string;
  origins: readonly string[];
}

export async function storeLesson(
  { tenantId, store, config }: FailureTarget,
  text: string,
  caller?: LessonCaller,
): Promise<'stored' | 'duplicate'> {
  const sig = failureSignature(text);
  const held = await store.lessonWrites.contentsWithTag(tenantId, 'auto-captured', caller?.origins);
  if (held.some((content) => failureSignature(content) === sig)) return 'duplicate';
  const entry = createMemory(text, {
    tags: ['error', 'auto-captured'],
    source: 'tool-failure',
    confidence: 'observed',
    tenantId,
    baseHalfLifeDays: config.defaultHalfLifeDays,
  });
  // A caller's project is its checked one; the store's own folder would name the server.
  const write =
    caller === undefined
      ? { entry, actor: CLI_ACTOR }
      : { entry: { ...entry, originProject: caller.originProject }, actor: caller.actor };
  await store.entryWrites.writeEntry(write);
  return 'stored';
}
