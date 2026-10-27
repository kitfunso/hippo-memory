// The one process probe: pidfiles ask "is this pid still running" through it.
import { errorCode } from '../base/util/log.js';

/** Signal 0 throws ESRCH for a dead pid and EPERM for a live process of another user, which
 * still counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
}
