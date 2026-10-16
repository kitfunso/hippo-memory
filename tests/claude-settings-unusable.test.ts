// init, hook install, hook uninstall and setup each warn once when Claude Code's settings.json is not JSON hippo can edit, and leave the file as it was.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runInProcess } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();
let root: string;
let settings: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-unusable-'));
  fs.mkdirSync(path.join(root, 'repo'));
  fs.mkdirSync(path.join(root, 'empty-path'));
  fs.writeFileSync(path.join(root, 'repo', 'CLAUDE.md'), '# Rules\n');
  fs.mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
  settings = path.join(root, 'home', '.claude', 'settings.json');
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

// A PATH with no codex on it, and no schedule or git call, so the run touches nothing outside the fake home.
async function hippo(...args: string[]): Promise<string> {
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_SKIP_AUTO_INTEGRATIONS']) vi.stubEnv(key, undefined);
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home'));
  vi.stubEnv('APPDATA', path.join(root, 'appdata'));
  vi.stubEnv('LOCALAPPDATA', path.join(root, 'localappdata'));
  vi.stubEnv('HIPPO_HOME', path.join(root, 'global'));
  vi.stubEnv('PATH', path.join(root, 'empty-path'));
  process.chdir(path.join(root, 'repo'));
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args, '--no-schedule', '--no-learn']));
    // A verb that sets process.exitCode instead of exiting fails here, as the real process would on exit.
    expect(r.status || Number(process.exitCode ?? 0), r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.exitCode = undefined;
  }
}

describe.each([
  ['null', 'null'],
  ['an array', '[]'],
  ['a null hooks value', '{"hooks":null}'],
  ['broken JSON', '{ "hooks": { "SessionEnd": [ }'],
])('a settings.json of %s', (_label, text) => {
  it.each([['init'], ['hook install claude-code'], ['hook uninstall claude-code'], ['setup']])('hippo %s warns once and leaves it unchanged', async (command) => {
    fs.writeFileSync(settings, text);

    const out = await hippo(...command.split(' '));

    expect(out.match(/left unchanged/g)).toHaveLength(1);
    expect(out).toContain(settings);
    expect(out).toContain(command.startsWith('hook uninstall') ? 'hippo hook uninstall claude-code' : 'hippo hook install claude-code');
    expect(out).not.toContain('already configured');
    expect(fs.readFileSync(settings, 'utf8')).toBe(text);
  });
});

describe('hippo hook uninstall on a settings.json it can edit', () => {
  it('says nothing about an unusable file when there are no hooks to remove', async () => {
    fs.writeFileSync(settings, '{"theme":"dark"}');

    expect(await hippo('hook', 'uninstall', 'claude-code')).not.toContain('left unchanged');
  });
});
