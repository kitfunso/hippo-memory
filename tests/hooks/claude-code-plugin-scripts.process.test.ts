// The Claude Code plugin's hooks and MCP server start these node scripts, which start the hippo CLI from PATH.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeRoot } from '../_helpers/make-root.js';

const SCRIPTS = join(fileURLToPath(new URL('../..', import.meta.url)), 'extensions', 'claude-code-plugin', 'scripts');
const WIN = process.platform === 'win32';

let dir: string;
let bin: string;
let empty: string;
let project: string;
// A space and a %NAME% pair, so a cmd.exe that splits or expands the argument fails the session-end test.
let home: string;

/** A `hippo` that prints its argv and stdin as JSON and exits with FAKE_HIPPO_EXIT. */
function writeFakeHippo(folder: string, body: string): void {
  writeFileSync(join(folder, 'fake.mjs'), body);
  if (WIN) {
    writeFileSync(join(folder, 'hippo.cmd'), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
  } else {
    writeFileSync(join(folder, 'hippo'), `#!/bin/sh\nexec "${process.execPath}" "${join(folder, 'fake.mjs')}" "$@"\n`);
    chmodSync(join(folder, 'hippo'), 0o755);
  }
}

beforeAll(() => {
  dir = realpathSync.native(makeRoot('plugin-scripts', { init: false }));
  bin = join(dir, 'bin');
  empty = join(dir, 'empty');
  project = join(dir, 'project');
  home = join(dir, 'home dir %USERNAME%');
  for (const folder of [bin, empty, project, home]) mkdirSync(folder);
  writeFakeHippo(
    bin,
    "let stdin = '';\nprocess.stdin.on('data', (d) => (stdin += d));\nprocess.stdin.on('end', () => {\n" +
      '  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));\n' +
      '  process.exit(Number(process.env.FAKE_HIPPO_EXIT ?? 0));\n});\n',
  );
  writeFakeHippo(project, "process.stdout.write('HIJACK');\n");
});

function run(script: string, args: readonly string[], pathDir: string, exitCode = 0) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(path|home|userprofile|fake_hippo_exit)$/i.test(key)),
  );
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: project,
    env: { ...env, PATH: pathDir, HOME: home, USERPROFILE: home, FAKE_HIPPO_EXIT: String(exitCode) },
    input: '{"hook":"payload"}',
    encoding: 'utf8',
  });
}

describe('plugin hook script', () => {
  it('passes the args and stdin to hippo from PATH, and exits 0 when hippo fails', () => {
    const result = run('hook.mjs', ['context', '--pinned-only'], bin, 3);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['context', '--pinned-only'], stdin: '{"hook":"payload"}' });
  });

  it('gives session-end the last-sleep log under the home folder', () => {
    const result = run('hook.mjs', ['session-end'], bin);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['session-end', '--log-file', join(home, '.hippo', 'logs', 'last-sleep.log')],
      stdin: '{"hook":"payload"}',
    });
  });

  it('exits 0 with no output when hippo is not on PATH, and never runs one from the project folder', () => {
    const result = run('hook.mjs', ['last-sleep'], empty);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('plugin MCP script', () => {
  it("runs hippo mcp and passes hippo's exit code through", () => {
    const result = run('mcp.mjs', [], bin, 3);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['mcp'], stdin: '{"hook":"payload"}' });
  });

  it('exits 1 with the install command when hippo is not on PATH', () => {
    const result = run('mcp.mjs', [], empty);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('npm install -g hippo-memory');
  });
});
