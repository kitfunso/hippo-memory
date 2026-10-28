// A store folder can sit inside a user's repo, so the file holding the live server key must never be
// committable.
import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORE_FILE = '.gitignore';
const KEY_LINE = 'server.key';

/** Makes `<hippoRoot>/.gitignore` list `server.key`: creates the file, or appends the line when it
 * is absent and leaves every other line as it is. */
export function ensureKeyGitignored(hippoRoot: string): void {
  const file = path.join(hippoRoot, IGNORE_FILE);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => line.trim() === KEY_LINE)) return;
  const joiner = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.mkdirSync(hippoRoot, { recursive: true });
  fs.appendFileSync(file, `${joiner}${KEY_LINE}\n`);
}
