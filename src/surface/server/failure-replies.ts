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
import { runWithRequestId } from '../../base/util/request-scope.js';
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
    // The id lets an operator find the logged cause without the client seeing internal text.
    sendJson(res, 500, { error: mapped.message, requestId });
    return;
  }
  // RecallContractError keeps the shared {error} shape and adds `code` so clients branch without
  // parsing prose.
  if (err instanceof RecallContractError) {
    sendJson(res, 400, { error: err.message, code: err.code });
    return;
  }
  if (err instanceof DeadlineExceededError) {
    sendJson(res, 504, { error: err.message, code: err.code, requestId });
    return;
  }
  // readBody hit its cap or deadline, so close once the 413 or 408 is out rather than drain what
  // the client keeps sending.
  if (err instanceof BodyTooLargeError || err instanceof BodyTimeoutError) {
    res.once('finish', () => closeAfterReply(req));
  }
  sendError(res, mapped.status, mapped.message);
}

const HANDLER_LATE =
  'the request did not finish by its deadline and was abandoned; a write it started may or may not be saved';

// The caller already has its 504, so this line is the only trace of the failure. The path and the
// error text can hold caller data, so it carries neither.
function logLateFailure<E>(req: IncomingMessage, err: E, requestId: string): void {
  const fields = {
    requestId,
    method: req.method ?? 'GET',
    route: accessRouteOf(req),
    failureStatus: replyFor(err).status,
  };
  log.warn('request failed after its deadline reply', { ...fields, ...errorClassFields(err) });
}

// A handler that ends after the 504 finds the response finished, so sending its own reply throws
// this: its work ran to the end.
function isDroppedLateReply<E>(err: E): boolean {
  return errorCode(err) === 'ERR_HTTP_HEADERS_SENT';
}

/** A GET only reads; every other method this server routes can write. */
const isRead = (method: string): boolean => method === 'GET';

// A read that ends late changed nothing. A write that ends late ran to its end after its caller was
// told it may not have been saved.
function logLateFinish(req: IncomingMessage, requestId: string): void {
  const method = req.method ?? 'GET';
  if (isRead(method)) return;
  log.info('request finished after its deadline reply; its own reply was dropped', {
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
    // A throw here would be an unhandled rejection, which stops the daemon for every caller.
    log.error(
      `serve: failure reply not sent, socket closed: ${errorMessage(replyErr)}`,
      errorFields(replyErr),
    );
    res.destroy();
  }
}

/**
 * Runs `handle` under the request's id and deadline; a failure becomes the reply, unless the
 * deadline has already answered.
 *
 */
export function answerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handle: () => Promise<void>,
  {
    slowWarnMs,
    counts,
  }: { slowWarnMs: number | undefined; counts: Pick<ServerCounts, 'handlerDeadlines'> },
): void {
  const requestId = openRequest(req, res, slowWarnMs);
  const deadline = requestDeadlineFor(req);
  const abort = deadline ? new AbortController() : undefined;
  // Inside the scope, so the failure reply's log line carries the id too.
  runWithRequestId(
    requestId,
    () => {
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
      handle().then(
        () => {
          if (isAbandoned(res)) logLateFinish(req, requestId);
        },
        <E>(err: E) => {
          if (!isAbandoned(res)) replyOrClose(req, res, err, requestId);
          else if (isDroppedLateReply(err)) logLateFinish(req, requestId);
          else logLateFailure(req, err, requestId);
        },
      );
    },
    deadline,
    abort?.signal,
  );
}
