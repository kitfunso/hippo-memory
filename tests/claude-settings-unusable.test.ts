// init, hook install, hook uninstall and setup each warn once when Claude Code's settings.json is not JSON hippo can edit, and leave the file as it was.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hippoRun } from './_helpers/spawn-hippo.js';

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
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// A PATH with no codex on it, and no schedule or git call, so the run touches nothing outside the fake home.
function hippo(...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(path|claude_config_dir|codex_home|hippo_skip_auto_integrations)$/i.test(key)) delete env[key];
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    HIPPO_HOME: path.join(root, 'global'),
    PATH: path.join(root, 'empty-path'),
  });
  const r = hippoRun([...args, '--no-schedule', '--no-learn'], { cwd: path.join(root, 'repo'), env });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe.each([
  ['null', 'null'],
  ['an array', '[]'],
  ['a null hooks value', '{"hooks":null}'],
  ['broken JSON', '{ "hooks": { "SessionEnd": [ }'],
])('a settings.json of %s', (_label, text) => {
  it.each([['init'], ['hook install claude-code'], ['hook uninstall claude-code'], ['setup']])('hippo %s warns once and leaves it unchanged', (command) => {
    fs.writeFileSync(settings, text);

    const out = hippo(...command.split(' '));

    expect(out.match(/left unchanged/g)).toHaveLength(1);
    expect(out).toContain(settings);
    expect(out).toContain(command.startsWith('hook uninstall') ? 'hippo hook uninstall claude-code' : 'hippo hook install claude-code');
    expect(out).not.toContain('already configured');
    expect(fs.readFileSync(settings, 'utf8')).toBe(text);
  });
});

describe('hippo hook uninstall on a settings.json it can edit', () => {
  it('says nothing about an unusable file when there are no hooks to remove', () => {
    fs.writeFileSync(settings, '{"theme":"dark"}');

    expect(hippo('hook', 'uninstall', 'claude-code')).not.toContain('left unchanged');
  });
});
