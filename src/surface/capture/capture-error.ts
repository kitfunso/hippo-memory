// `hippo capture-error`, run by the Claude Code PostToolUseFailure hook: routine failures and
// repeats are not stored, because error memories decay slowly and would crowd out real lessons;
// what is stored stays `observed` until outcome feedback confirms it. Every failure, stored or not,
// goes to the failure log.
import type { InfraPorts } from '../../base/ports/infra.js';
import { CLI_ACTOR } from '../../base/records/audit-ops.js';
import { createMemoryAt, ERROR_TAG } from '../../base/memory/entry.js';
import {
  failureHash,
  failureSignature,
  lessonFromFailure,
  payloadString,
  type FailureReading,
} from './failure-reading.js';
import type { JsonValue } from '../../base/util/json.js';
import type {
  CaptureErrorOutcome,
  FailureEvent,
  FailureOutcome,
} from '../../base/records/rejections.js';
import type { HippoDbContext } from '../../api/hippo-db-context.js';
import { heldLessons, logFailure } from '../../api/hippo-db/failure-log.js';

/** The store a failure is logged and its lesson kept in, with that store's config. */
export type FailureTarget = Pick<HippoDbContext, 'tenantId' | 'store' | 'config'> & {
  readonly infra: Pick<InfraPorts, 'clock'>;
};

/**
 * Store a failure as an error memory unless it is routine or a repeat, and log it either way, even
 * when storing throws.
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
    await logAndReport({ target, payload, lesson, outcome, onLogged });
  }
}

interface LogAndReportOptions {
  readonly target: FailureTarget;
  readonly payload: JsonValue;
  readonly lesson: FailureReading;
  readonly outcome: FailureOutcome;
  readonly onLogged: ((failureId: number | null) => void) | undefined;
}

/** Logs the failure, then tells the caller the row id, or null when the write threw; the throw
 * goes on. */
async function logAndReport({
  target,
  payload,
  lesson,
  outcome,
  onLogged,
}: LogAndReportOptions): Promise<void> {
  let id: number;
  try {
    id = await logFailure(target, failureEvent(payload, lesson, outcome));
  } catch (error) {
    onLogged?.(null);
    throw error;
  }
  onLogged?.(id);
}

/** The log row's fields: what the payload names, and hashes rather than the failure's text. */
function failureEvent(
  payload: JsonValue,
  lesson: FailureReading,
  outcome: FailureOutcome,
): Omit<FailureEvent, 'tenantId'> {
  const hash = (s: string | null): string | null => (s === null ? null : failureHash(s));
  return {
    sessionId: payloadString(payload, 'session_id'),
    tool: payloadString(payload, 'tool_name'),
    outcome,
    rule: 'rule' in lesson ? lesson.rule : null,
    sigHash: hash(lesson.text),
    detailHash: hash(lesson.detail),
  };
}

/** Who sent a failure from another machine: the audit actor and the project its lesson and
 * repeat check belong to. */
export interface LessonCaller {
  actor: string;
  originProject: string;
  origins: readonly string[];
}

export async function storeLesson(
  { tenantId, store, config, infra }: FailureTarget,
  text: string,
  caller?: LessonCaller,
): Promise<'stored' | 'duplicate'> {
  const sig = failureSignature(text);
  const held = await heldLessons({ store, tenantId }, caller?.origins);
  if (held.some((content) => failureSignature(content) === sig)) return 'duplicate';
  const entry = createMemoryAt(
    text,
    {
      tags: [ERROR_TAG, 'auto-captured'],
      source: 'tool-failure',
      confidence: 'observed',
      tenantId,
      baseHalfLifeDays: config.defaultHalfLifeDays,
    },
    infra.clock(),
  );
  // A caller's project is its checked one; the store's own folder would name the server.
  const write =
    caller === undefined
      ? { entry, actor: CLI_ACTOR }
      : { entry: { ...entry, originProject: caller.originProject }, actor: caller.actor };
  await store.entryWrites.writeEntry(write);
  return 'stored';
}
