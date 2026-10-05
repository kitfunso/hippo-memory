// init, hook install and setup each warn once when Claude Code's settings.json is not a JSON object, and leave the file as it was.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

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
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args, '--no-schedule', '--no-learn'], { cwd: path.join(root, 'repo'), env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe.each([['null', 'null'], ['an array', '[]']])('a settings.json of %s', (_label, text) => {
  it.each([['init'], ['hook install claude-code'], ['setup']])('hippo %s warns once and leaves it unchanged', (command) => {
    fs.writeFileSync(settings, text);

    const out = hippo(...command.split(' '));

    expect(out.match(/left unchanged/g)).toHaveLength(1);
    expect(out).toContain(settings);
    expect(out).not.toContain('already configured');
    expect(fs.readFileSync(settings, 'utf8')).toBe(text);
  });
});
