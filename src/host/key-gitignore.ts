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
    // Git drops trailing spaces but keeps leading ones, so only the end is trimmed.
    const line = (lines[at] ?? '').replace(/\s+$/, '');
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
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (keyIgnored(current)) return;
  const joiner = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.mkdirSync(hippoRoot, { recursive: true });
  fs.appendFileSync(file, `${joiner}${KEY_LINE}\n`);
}
