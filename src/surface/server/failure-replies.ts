import type { IncomingMessage, ServerResponse } from 'node:http';
import { RecallContractError } from '../../api/index.js';
import { isStoreBusy } from '../../base/ports/store.js';
import {
  BodyTimeoutError,
  BodyTooLargeError,
  DeadlineExceededError,
  HttpError,
} from '../../base/errors/http-errors.js';
import {
  errorCode,
  errorClassFields,
  errorFields,
  errorMessage,
  log,
} from '../../base/util/log.js';
import { runWithRequestId, type RequestLimits } from '../../base/util/request-scope.js';
import { answerAtDeadline, isAbandoned, requestDeadlineFor } from './deadline.js';
import { closeAfterReply, sendJson } from '../http/http-util.js';
import {
  accessRouteOf,
  endReply,
  logRequestFailure,
  openRequest,
  replyFor,
  sendError,
} from './request.js';
import type { ServerCounts } from './types.js';

function replyWithFailure<E>(
  req: IncomingMessage,
  res: ServerResponse,
  err: E,
  requestId: string,
): void {
  const mapped = replyFor(err);
  logRequestFailure(req, err, mapped.status);
  if (res.headersSent) {
    endReply(res);
    return;
  }
  if (isStoreBusy(err)) {
    res.setHeader('Retry-After', '1');
  } else if (err instanceof HttpError && err.retryAfterSec !== undefined) {
    res.setHeader('Retry-After', String(err.retryAfterSec));
  }
  if (mapped.status === 500) {
    sendJson(res, 500, { error: mapped.message, requestId });
    return;
  }
  if (err instanceof RecallContractError) {
    sendJson(res, 400, { error: err.message, code: err.code });
    return;
  }
  if (err instanceof DeadlineExceededError) {
    sendJson(res, 504, { error: err.message, code: err.code, requestId });
    return;
  }
  if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) {
    res.once('finish', () => closeAfterReply(req));
  }
  sendError(res, mapped.status, mapped.message);
}

const HANDLER_LATE =
  'the request did not finish by its deadline and was abandoned; a write it started may or may not be saved';

function logLateFailure<E>(req: IncomingMessage, err: E, requestId: string): void {
  const fields = {
    requestId,
    method: req.method ?? 'GET',
    route: accessRouteOf(req),
    failureStatus: replyFor(err).status,
  };
  log.warn('request failed after its deadline reply', { ...fields, ...errorClassFields(err) });
}

function isDroppedLateReply<E>(err: E): boolean {
  return errorCode(err) === 'ERR_HTTP_HEADERS_SENT';
}

const isRead = (method: string): boolean => method === 'GET';

function logLateFinish(req: IncomingMessage, requestId: string): void {
  const method = req.method ?? 'GET';
  if (isRead(method)) return;
  log.trail('request finished after its deadline reply; its own reply was dropped', {
    requestId,
    method,
    route: accessRouteOf(req),
  });
}

function replyOrClose<E>(
  req: IncomingMessage,
  res: ServerResponse,
  err: E,
  requestId: string,
): void {
  try {
    replyWithFailure(req, res, err, requestId);
  } catch (replyErr) {
    log.error(
      `serve: failure reply not sent, socket closed: ${errorMessage(replyErr)}`,
      errorFields(replyErr),
    );
    res.destroy();
  }
}

/**
 * Runs `handle` under the request's id with its deadline and abort signal; a failure becomes the
 * reply, unless the deadline has already answered.
 */
export function answerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (limits: RequestLimits) => Promise<void>,
  {
    slowWarnMs,
    counts,
  }: { slowWarnMs: number | undefined; counts: Pick<ServerCounts, 'handlerDeadlines'> },
): void {
  const requestId = openRequest(req, res, slowWarnMs);
  const deadline = requestDeadlineFor(req);
  const abort = deadline ? new AbortController() : undefined;
  runWithRequestId(requestId, () => {
    if (deadline) {
      answerAtDeadline(
        res,
        deadline,
        () => {
          counts.handlerDeadlines += 1;
          replyOrClose(req, res, new DeadlineExceededError(HANDLER_LATE), requestId);
        },
        () => abort?.abort(new DeadlineExceededError(HANDLER_LATE)),
      );
    }
    handle({ deadline, signal: abort?.signal }).then(
      () => {
        if (isAbandoned(res)) logLateFinish(req, requestId);
      },
      <E>(err: E) => {
        if (!isAbandoned(res)) replyOrClose(req, res, err, requestId);
        else if (isDroppedLateReply(err)) logLateFinish(req, requestId);
        else logLateFailure(req, err, requestId);
      },
    );
  });
}
