// A store folder can sit inside a user's repo, so the file holding the live server key must never be
// committable.
import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORE_FILE = '.gitignore';
const KEY_LINE = 'server.key';

/** True when the file's own rules leave `server.key` ignored. Git lets the last matching rule
 * win, so a `!` line below the key line could undo it; any such line counts as a negation. */
function keyIgnored(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let at = lines.length - 1; at >= 0; at--) {
    // Git trims only trailing spaces; a leading space or a trailing tab stays part of the pattern.
    const line = (lines[at] ?? '').replace(/ +$/, '');
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('!')) return false;
    if (line === KEY_LINE) return true;
  }
  return false;
}

/** Makes `<hippoRoot>/.gitignore` end up ignoring `server.key`: creates the file, or appends the
 * line when no later rule already settles it, and leaves every other line as it is. */
export function ensureKeyGitignored(hippoRoot: string): void {
  const file = path.join(hippoRoot, IGNORE_FILE);
  fs.mkdirSync(hippoRoot, { recursive: true });
  // One open serves the read and the append, so the file cannot be swapped between the two.
  const fd = fs.openSync(file, 'a+');
  try {
    const bytes = Buffer.alloc(fs.fstatSync(fd).size);
    const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const current = bytes.subarray(0, read).toString('utf8');
    if (keyIgnored(current)) return;
    const joiner = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.writeSync(fd, `${joiner}${KEY_LINE}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
