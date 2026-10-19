// Leaf module: the named best-effort probes. Each absorbs the one failure its parser or system call documents and
// throws every other error on, so no catch in src swallows a failure it did not name.

/** The errno name of a thrown value (ENOENT, EACCES), or '' when it has none. */
function errnoName<E>(err: E): string {
  return err instanceof Error && 'code' in err ? String(err.code) : '';
}

/** The errors that mean a path holds nothing to read: absent, not a directory entry, or closed to this user. */
export const PATH_UNREADABLE = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'] as const;

/** `fn()`, or undefined when it throws an error whose errno name is in `codes`; any other error is thrown on. */
export function ignoringCodes<T>(codes: readonly string[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (codes.includes(errnoName(err))) return undefined;
    throw err;
  }
}

/** The decoded text, or undefined for a malformed percent escape (the URIError decodeURIComponent documents). */
export function tryDecodeUri(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}
