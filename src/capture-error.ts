// `hippo capture-error`, run by the Claude Code PostToolUseFailure hook: routine failures and repeats are not
// stored, because error memories decay slowly and would crowd out real lessons; what is stored stays `observed`
// until outcome feedback confirms it. Every failure, stored or not, goes to the failure log.
import { createMemory } from './memory.js';
import { writeEntry } from './store/entry-writes.js';
import { loadContentsWithTag } from './store/entry-reads.js';
import { loadConfig } from './config.js';
import { closeHippoDb, openHippoDb } from './db.js';
import { recordFailure, type CaptureErrorOutcome, type FailureOutcome } from './store/failure-log.js';
import {
  failureHash,
  failureSignature,
  lessonFromFailure,
  payloadString,
  type FailureReading,
} from './capture/failure-reading.js';
import type { JsonValue } from './json.js';

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
  const hash = (s: string | null): string | null => (s === null ? null : failureHash(s));
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

/** Who sent a failure from another machine: the audit actor and the project its lesson and repeat check belong to. */
export interface LessonCaller {
  actor: string;
  originProject: string;
  origins: readonly string[];
}

export function storeLesson(hippoRoot: string, tenantId: string, text: string, caller?: LessonCaller): 'stored' | 'duplicate' {
  const sig = failureSignature(text);
  const repeat = loadContentsWithTag(hippoRoot, tenantId, 'auto-captured', caller?.origins).some(
    (content) => failureSignature(content) === sig,
  );
  if (repeat) return 'duplicate';
  const entry = createMemory(text, {
    tags: ['error', 'auto-captured'],
    source: 'tool-failure',
    confidence: 'observed',
    tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
  });
  // A caller's project is its checked one; the store's own folder would name the server.
  if (caller === undefined) writeEntry(hippoRoot, entry);
  else writeEntry(hippoRoot, { ...entry, origin_project: caller.originProject }, { actor: caller.actor });
  return 'stored';
}
