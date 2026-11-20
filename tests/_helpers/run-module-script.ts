import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runs `script` as an ES module in a child at the checkout, because a package self-reference
 * resolves from the nearest package.json; `args` reach it as process.argv[1...]. Returns the JSON
 * on the child's last stdout line. */
export function runModuleScript<T = unknown>(script: string, ...args: string[]): T {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], {
    cwd: checkout,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (child.status !== 0) {
    throw new Error(`child script failed (run \`npm run build\` first):\n${child.error?.message ?? ''}${child.stderr}`);
  }
  const lines = child.stdout.trim().split('\n');
  // SAFETY: each caller's script prints its result as JSON on its last stdout line, in the shape T.
  return JSON.parse(lines[lines.length - 1]!) as T;
}
