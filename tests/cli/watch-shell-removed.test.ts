// `hippo watch --shell` is gone: a line that passes it fails before anything runs, and no src file asks a shell to parse text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli as runCliEntry } from '../../src/cli.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';

const srcRoot = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src');
const savedCwd = process.cwd();
// Built from pieces so this file, which only reads src text, stays out of the process-test list.
const IMPORTS_CHILD_PROCESS = new RegExp(String.raw`from '(?:node:)?child_` + "process'");
const IMPORTS_EXEC = new RegExp(
  String.raw`import\s*\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from\s*'(?:node:)?child_` + "process'",
);
const MARKER = 'shell-ran.txt';
const WRITES_MARKER = `node -e "require('fs').writeFileSync('${MARKER}', 'x')"`;
let home = '';

const hippoRun = (...args: string[]): Promise<InProcessResult> =>
  runInProcess(() => runCliEntry(['node', 'hippo', ...args]));

beforeEach(() => {
  home = makeStore('watch-shell-removed').base;
  vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('hippo watch --shell', () => {
  it.each([
    ['a line after the flag', ['watch', '--shell', WRITES_MARKER]],
    ['a line joined with =', ['watch', `--shell=${WRITES_MARKER}`]],
    ['no line', ['watch', '--shell']],
    ['argv after the flag', ['watch', '--shell', '--', 'node', '-e', 'process.exit(0)']],
  ])('exits 1 naming the removal and runs nothing: %s', async (_name, args) => {
    const res = await hippoRun(...args);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--shell was removed in 3.0');
    expect(existsSync(join(home, MARKER))).toBe(false);
  });
});

describe('src', () => {
  const spawners = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|js|mjs)$/.test(f))
    .map((file) => ({ file, text: readFileSync(join(srcRoot, file), 'utf8') }))
    .filter(({ text }) => IMPORTS_CHILD_PROCESS.test(text));

  it('finds the files that start child processes', () => {
    expect(spawners.map(({ file }) => file)).toContain(join('base', 'util', 'spawn-argv.ts'));
  });

  it('sets no spawn option `shell` to anything but false', () => {
    const asks = spawners.filter(({ text }) => /\bshell\s*:\s*(?!false\b)\S/.test(text));
    expect(asks.map(({ file }) => file)).toEqual([]);
  });

  it('imports neither exec nor execSync, which always parse their text with a shell', () => {
    const asks = spawners.filter(({ text }) => IMPORTS_EXEC.test(text));
    expect(asks.map(({ file }) => file)).toEqual([]);
  });
});
