import type { MessagePort } from 'node:worker_threads';
import { errorFields, errorMessage, log } from './log.js';

/** The part of a worker `MessagePort` a reply needs. */
export type ReplyPort = Pick<MessagePort, 'postMessage'>;
type TransferList = Parameters<MessagePort['postMessage']>[1];

// process.exit ends a worker thread, not the process; the server then rejects every call left.
const endThread = (): never => process.exit(1);

/**
 * Posts `reply`; one that cannot be copied becomes `failureOf(cause)`. When that cannot be posted
 * either, the port is dead and no caller can be told, so the thread ends and the server rejects
 * every call left on it.
 */
export function postReply<R, F>(
  port: ReplyPort,
  {
    reply,
    transfer,
    failureOf,
    what,
    end = endThread,
  }: {
    reply: R;
    transfer: TransferList;
    failureOf: (cause: unknown) => F;
    what: string;
    end?: () => void;
  },
): void {
  try {
    port.postMessage(reply, transfer);
    return;
  } catch (err) {
    log.error(`${what} could not be sent: ${errorMessage(err)}`, errorFields(err));
    try {
      port.postMessage(failureOf(err));
      return;
    } catch (second) {
      log.error(
        `${what}: its failure could not be sent either, ending the thread`,
        errorFields(second),
      );
    }
  }
  end();
}
