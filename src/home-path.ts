// Home-directory paths name their user, so text bound for a shared store tests or masks them here; no imports keep it light.

// VS Code writes file links URL-encoded, so a separator may be %5C or %2F.
const WIN_SEP = String.raw`(?:[\\/]|%5C|%2F)`;
const WIN_CHAR = String.raw`(?:(?!%5C|%2F)[^\\/:*?"<>|\s])`;
// A Windows name never holds a quote, so JSON stops it; one with spaces runs to a separator, quote, closing mark or line end, leaving the mark, as stopping at its first word leaks the surname.
const WIN_USER = String.raw`(?:${WIN_CHAR}+(?: ${WIN_CHAR}+){0,3}(?=${WIN_SEP}|["'\`)\]>,;]|\.(?=\s|$)|(?<!\.)(?:[^\S ]|$))(?<![\`)\],;'])|${WIN_CHAR}+)`;

/** One pattern per path shape that carries a user name: Windows, Git Bash and WSL mounts, extended-length, UNC home shares, Linux, macOS and 8.3 short names. */
export const USER_SEGMENT: readonly RegExp[] = [
  new RegExp(String.raw`[A-Za-z](?::|%3A)${WIN_SEP}+(?:Users|Documents and Settings)${WIN_SEP}+${WIN_USER}`, 'i'),
  new RegExp(String.raw`(?<![\w.])(?:\/mnt)?\/[A-Za-z]\/Users\/${WIN_USER}`, 'i'),
  /\\\\\?\\/,
  new RegExp(String.raw`\\\\[^\\/\s]+\\+(?:homes?|users|profiles?)\$?\\+${WIN_USER}`, 'i'),
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
