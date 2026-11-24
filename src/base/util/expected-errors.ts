import { errorCode } from './log.js';

/** The errors that mean a path holds nothing to read: absent, not a directory entry, or closed
 * to this user. */
export const PATH_UNREADABLE = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'] as const;

/** True for a failed system call; Node's own ERR_* validation errors carry a code but no syscall. */
export function isFileSystemError(cause: unknown): cause is NodeJS.ErrnoException {
  return (
    cause instanceof Error &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    'syscall' in cause &&
    typeof cause.syscall === 'string'
  );
}

/** `fn()`, or undefined when it throws an error whose errno name is in `codes`; any other error
 * is thrown on. */
export function ignoringCodes<T>(codes: readonly string[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (codes.includes(errorCode(err))) return undefined;
    throw err;
  }
}

/** The decoded text, or undefined for a malformed percent escape (the URIError
 * decodeURIComponent documents). */
export function tryDecodeUri(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}
