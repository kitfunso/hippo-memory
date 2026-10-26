// An Error cannot cross to a child process or a worker thread, so a failure travels as its message, its stack and
// whether the store was busy, and the server rebuilds the error from them.
import { isStoreBusy, StoreBusyError } from '../../base/ports/store.js';
import { errorMessage } from '../../base/util/log.js';

/** A failure as it crosses the boundary. */
export interface FailureReply {
  readonly ok: false;
  readonly busy: boolean;
  readonly message: string;
  readonly stack?: string;
}

/** The reply for an error the child or the thread caught. */
export function failureReply<E>(err: E): FailureReply {
  return {
    ok: false,
    busy: isStoreBusy(err),
    message: errorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

/** The error a failure reply stands for: a lock the other side could not get is the retryable 503 a route gives. */
export function replyError(reply: FailureReply): Error {
  if (reply.busy) return new StoreBusyError(reply.message);
  const failure = new Error(reply.message);
  if (reply.stack) failure.stack = reply.stack;
  return failure;
}
