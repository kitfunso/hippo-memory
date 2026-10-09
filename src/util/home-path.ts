// Home-directory paths name their user, so text bound for a shared store tests or masks them here; no imports keep it light.

// VS Code writes file links URL-encoded, so a separator may be %5C or %2F.
const WIN_SEP = String.raw`(?:[\\/]|%5[Cc]|%2[Ff])`;
const WIN_CHAR = String.raw`(?:(?!%5[Cc]|%2[Ff])[^\\/:*?"<>|\s])`;
// A Windows name never holds a quote, so JSON stops it; one with spaces runs to a separator, quote, closing mark or line end, leaving the mark, as stopping at its first word leaks the surname.
const WIN_USER = String.raw`(?:${WIN_CHAR}+(?: ${WIN_CHAR}+){0,3}(?=${WIN_SEP}|["'\`)\]>,;]|\.(?=\s|$)|(?<!\.)(?:[^\S ]|$))(?<![\`)\],;'])|${WIN_CHAR}+)`;

// Slash-led homes with their case spelled out and no flag, so one pattern can hold all four: Git Bash and WSL mounts, Linux, root and macOS.
const MOUNT_HOME = String.raw`(?:\/[Mm][Nn][Tt])?\/[A-Za-z]\/[Uu][Ss][Ee][Rr][Ss]\/${WIN_USER}`;
const LINUX_HOME = String.raw`(?:\/var)?\/home\/[^/\s]+`;
const ROOT_HOME = String.raw`(?:\/var)?\/root(?![\w.-])`;
const MAC_HOME = String.raw`\/Users\/[^/\s]+`;

const DRIVE_HOME = new RegExp(String.raw`[A-Za-z](?::|%3A)${WIN_SEP}+(?:Users|Documents and Settings)${WIN_SEP}+${WIN_USER}`, 'i');
const LONG_PATH = /\\\\\?\\/;
const SHARE_HOME = new RegExp(String.raw`\\\\[^\\/\s]+\\+(?:homes?|users|profiles?)\$?\\+${WIN_USER}`, 'i');
const SHORT_NAME = /[\\/][A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?(?![\w~])|\b[A-Z0-9_$]{1,6}~\d{1,6}(?:\.[A-Z0-9]{1,3})?[\\/]/;

// A slash-led home counts only at the start of a path, so each takes a guard against the text before it.
const MOUNT_START = String.raw`(?<![\w.])${MOUNT_HOME}`;
const LINUX_START = String.raw`(?<![\w.~-])${LINUX_HOME}`;
const ROOT_START = String.raw`(?<![\w.~-])${ROOT_HOME}`;
const MAC_START = String.raw`(?<![\w.~-])${MAC_HOME}`;

/** One pattern per path shape that carries a user name: Windows, Git Bash and WSL mounts, extended-length, UNC home shares, Linux, macOS and 8.3 short names. */
export const USER_SEGMENT: readonly RegExp[] = [
  DRIVE_HOME,
  new RegExp(MOUNT_START),
  LONG_PATH,
  SHARE_HOME,
  new RegExp(LINUX_START),
  new RegExp(ROOT_START),
  new RegExp(MAC_START),
  SHORT_NAME,
];

const MASK = '[home]';

// Global copies, so the shared test patterns keep their lastIndex at 0.
const allOf = (re: RegExp): RegExp => new RegExp(re.source, `${re.flags}g`);
const [DRIVE_HOMES, LONG_PATHS, SHARE_HOMES, SHORT_NAMES] = [DRIVE_HOME, LONG_PATH, SHARE_HOME, SHORT_NAME].map(allOf);

// A home glued after another starts where a mask will end, which no guard refuses: one match takes the whole run, as masking one a pass costs a pass per home.
// A run holds only shapes whose own step is not still to come, so a later step meets the same text it would without the run.
const runFrom = (start: string, ...glued: readonly string[]): RegExp => new RegExp(`${start}(?:${glued.join('|')})*`, 'g');
const MOUNT_RUNS = runFrom(MOUNT_START, MOUNT_HOME);
const LINUX_RUNS = runFrom(LINUX_START, MOUNT_HOME, LINUX_HOME);
const ROOT_RUNS = runFrom(ROOT_START, MOUNT_HOME, LINUX_HOME, ROOT_HOME);
const MAC_RUNS = runFrom(MAC_START, MOUNT_HOME, LINUX_HOME, ROOT_HOME, MAC_HOME);
const SLASH_HOMES = new RegExp(`${MOUNT_HOME}|${LINUX_HOME}|${ROOT_HOME}|${MAC_HOME}`, 'g');
const maskRun = (run: string): string => MASK.repeat(run.match(SLASH_HOMES)?.length ?? 1);

function maskOnce(text: string): string {
  return text
    .replace(DRIVE_HOMES, MASK)
    .replace(MOUNT_RUNS, maskRun)
    .replace(LONG_PATHS, MASK)
    .replace(SHARE_HOMES, MASK)
    .replace(LINUX_RUNS, maskRun)
    .replace(ROOT_RUNS, maskRun)
    .replace(MAC_RUNS, maskRun)
    .replace(SHORT_NAMES, MASK);
}

/** `text` with each home-directory segment replaced by `[home]`. */
export function maskHomePaths(text: string): string {
  let out = text;
  let next = maskOnce(out);
  // A mask can uncover a home path its text was hiding, so passes repeat until one changes nothing; each takes a separator out, so they end.
  while (next !== out) {
    out = next;
    next = maskOnce(out);
  }
  return out;
}
