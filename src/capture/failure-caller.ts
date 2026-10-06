// PostToolUseFailure for a caller on another machine: the lesson and its log row carry the caller's owner and project, and a retried request id gets the first answer.
import { BadRequestError } from '../api-errors.js';
import type { Context } from '../api/types.js';
import { storeLesson } from '../capture-error.js';
import { recordFailure, requestOutcome, settleFailureOutcome, type FailureOutcome } from '../failure-log.js';
import { errorMessage, log } from '../log.js';
import type { CallerProject } from '../prompt-hook.js';
import { scrubForSharing } from '../share-scrub.js';
import type { ContinuityKey } from '../store/sessions.js';
import { truncateCodePointSafe } from '../transcript-tail.js';
import { assertRequestId, bindCaller, withCallerDb } from './caller-session.js';
import { FAILURE_TEXT_MAX_CHARS, failureHash, type CaptureErrorOutcome, type RoutineRule } from './failure-reading.js';

type FailureSkip = Exclude<CaptureErrorOutcome, 'stored' | 'duplicate'>;

/** failureReport's reading of the payload, read on the caller's machine, plus the id its retries carry. */
export interface CallerFailureRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly tool: string | null;
  readonly text: string | null;
  readonly skip: FailureSkip | null;
  readonly rule: RoutineRule | null;
  readonly detailHash: string | null;
  readonly requestId: string;
}

export interface CallerFailureResult {
  readonly outcome: CaptureErrorOutcome;
}

const SKIPS = { 'skipped-interrupt': true, 'skipped-routine': true, 'skipped-invalid': true } as const satisfies Record<FailureSkip, true>;
const ROUTINE_RULES = { declined: true, 'os-permission': true, 'no-match': true, 'search-tool': true, 'quiet-exit': true } as const satisfies Record<RoutineRule, true>;

type CheckedFailure = { readonly skip: FailureSkip; readonly text: string | null } | { readonly skip: null; readonly text: string };

/** The shapes lessonFromFailure gives: text for a lesson or a routine skip, none for an interrupt or an unreadable payload, a rule only on a routine skip. */
function checkedFailure(req: CallerFailureRequest): CheckedFailure {
  assertRequestId(req.requestId);
  if (req.detailHash !== null && !/^[0-9a-f]{16}$/.test(req.detailHash)) throw new BadRequestError('detail hash: 16 lowercase hex characters or null');
  const { skip, text, rule } = req;
  if (skip !== null && !Object.hasOwn(SKIPS, skip)) throw new BadRequestError('skip: skipped-interrupt, skipped-routine, skipped-invalid or null');
  if ((skip === 'skipped-routine') !== (rule !== null) || (rule !== null && !Object.hasOwn(ROUTINE_RULES, rule))) {
    throw new BadRequestError('rule: a routine rule on skipped-routine, else null');
  }
  if (text === null || text.trim() === '') {
    if (skip === null || skip === 'skipped-routine') throw new BadRequestError('text: required for a lesson or a routine skip');
    return { skip, text: null };
  }
  if (skip === 'skipped-interrupt' || skip === 'skipped-invalid') throw new BadRequestError('text: null for an interrupt or an unreadable failure');
  if (text.length > FAILURE_TEXT_MAX_CHARS) throw new BadRequestError(`text: at most ${FAILURE_TEXT_MAX_CHARS} characters`);
  // Scrubbed again, as the caller's scrub is not trusted, and cut after it, as a mask can be longer than what it hides.
  return { skip, text: truncateCodePointSafe(scrubForSharing(text), FAILURE_TEXT_MAX_CHARS) };
}

export function captureFailureForCaller(ctx: Context, req: CallerFailureRequest): CallerFailureResult {
  const failure = checkedFailure(req);
  const key = bindCaller(ctx, req.sessionId, req.project);
  const earlier = withCallerDb(ctx, (db) => requestOutcome(db, ctx.tenantId, req.requestId, req.sessionId));
  // A retry after a lost reply gets the first answer and writes nothing; one whose store failed tries the store again.
  if (earlier !== null && earlier !== 'store-failed') return { outcome: earlier };
  let logged: FailureOutcome = 'store-failed';
  try {
    const caller = { actor: key.owner, originProject: req.project.name, origins: key.project };
    const outcome = failure.skip === null ? storeLesson(ctx.hippoRoot, ctx.tenantId, failure.text, caller) : failure.skip;
    logged = outcome;
    return { outcome };
  } finally {
    // The hash is of the text as stored, so a repeat counts against the lesson it repeats.
    logOutcome(ctx, { ...req, text: failure.text }, key, logged, earlier !== null);
  }
}

/** Runs after the outcome in its own try, so a log error never hides the store's error or its outcome. */
function logOutcome(ctx: Context, req: CallerFailureRequest, key: ContinuityKey, outcome: FailureOutcome, retried: boolean): void {
  try {
    withCallerDb(ctx, (db) => {
      // The request id allows one row, so a retry rewrites the first try's outcome.
      if (retried) {
        settleFailureOutcome(db, ctx.tenantId, req.requestId, outcome);
        return;
      }
      recordFailure(db, {
        tenantId: ctx.tenantId, sessionId: req.sessionId, tool: req.tool, outcome, rule: req.rule,
        sigHash: req.text?.trim() ? failureHash(req.text) : null, detailHash: req.detailHash,
        ownerSubject: key.owner, originProject: req.project.name, requestId: req.requestId,
      });
    });
  } catch (err) {
    log.warn(`capture-error: failure not logged: ${errorMessage(err)}`);
  }
}
