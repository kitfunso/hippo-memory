// Home-directory paths name their user, so text bound for a shared store tests or masks them here; no imports keep it light.

/** One pattern per path shape that carries a user name: Windows, Git Bash and WSL mounts, extended-length, Linux, macOS and 8.3 short names. */
export const USER_SEGMENT: readonly RegExp[] = [
  /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s]+/i,
  /(?<![\w.])(?:\/mnt)?\/[A-Za-z]\/Users\/[^/\s]+/i,
  /\\\\\?\\/,
  /(?<![\w.~-])(?:\/var)?\/home\/[^/\s]+/,
  /(?<![\w.~-])(?:\/var)?\/root(?![\w.-])/,
  /(?<![\w.~-])\/Users\/[^/\s]+/,
  /[\\/][A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?(?![\w~])|\b[A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?[\\/]/,
];

// Global copies, so the shared test patterns keep their lastIndex at 0.
const USER_SEGMENT_ALL: readonly RegExp[] = USER_SEGMENT.map((re) => new RegExp(re.source, `${re.flags}g`));

/** `text` with each home-directory segment replaced by `[home]`. */
export function maskHomePaths(text: string): string {
  return USER_SEGMENT_ALL.reduce((out, re) => out.replace(re, '[home]'), text);
}
