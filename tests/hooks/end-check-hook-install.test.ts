import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installJsonHooks,
  installJsonHooksWith,
  resolveJsonHookPaths,
  uninstallJsonHooks,
} from '../../src/surface/hooks-install/json-hooks.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { withFakeHome } from '../_helpers/with-fake-home.js';

const END_CHECK_COMMAND = 'hippo end-check';
const END_CHECK_GROUP = { hooks: [{ type: 'command', command: END_CHECK_COMMAND, timeout: 10 }] };
const USER_STOP_GROUP = { hooks: [{ type: 'command', command: 'node ~/hooks/stop.js' }] };
const SLEEP_STOP_GROUP = { hooks: [{ type: 'command', command: 'hippo sleep' }] };

let env: { cleanup: () => void; home: string };

beforeEach(() => {
  env = withFakeHome('hippo-end-check-install-');
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.cleanup();
});

function seed(settings: JsonValue): string {
  const { settings: file } = resolveJsonHookPaths('claude-code');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings), 'utf8');
  return file;
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const withEndCheck = () => installJsonHooksWith('claude-code', { endCheck: true });

function removeStopHook(file: string): void {
  const settings = read(file);
  delete settings.hooks.Stop;
  fs.writeFileSync(file, JSON.stringify(settings), 'utf8');
}

describe('installJsonHooksWith(claude-code, { endCheck: true })', () => {
  it('adds the Stop group once, and a second install adds no second one', () => {
    const first = withEndCheck();
    expect(first.installedEndCheck).toBe(true);
    expect(read(first.settingsPath).hooks.Stop).toEqual([END_CHECK_GROUP]);

    const second = withEndCheck();
    expect(second.installedEndCheck).toBe(false);
    expect(read(second.settingsPath).hooks.Stop).toEqual([END_CHECK_GROUP]);
  });

  it('adds it after a user Stop handler, which stays first', () => {
    const file = seed({ hooks: { Stop: [USER_STOP_GROUP] } });

    expect(withEndCheck().installedEndCheck).toBe(true);

    expect(read(file).hooks.Stop).toEqual([USER_STOP_GROUP, END_CHECK_GROUP]);
  });

  it('writes the file when it is the only hook missing', () => {
    const { settingsPath } = installJsonHooks('claude-code');
    const before = fs.readFileSync(settingsPath, 'utf8');

    const result = withEndCheck();

    expect(result.installedEndCheck).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).not.toBe(before);
    expect(read(settingsPath).hooks.Stop).toEqual([END_CHECK_GROUP]);
  });

  it('adds the hook back after the user removed it, because the flag asks for it', () => {
    const { settingsPath } = withEndCheck();
    removeStopHook(settingsPath);

    const again = withEndCheck();

    expect(again.leftOut).toEqual([]);
    expect(again.installedEndCheck).toBe(true);
    expect(read(settingsPath).hooks.Stop).toEqual([END_CHECK_GROUP]);
  });

  it('migrates the old sleep Stop hook and still adds the end check', () => {
    const file = seed({ hooks: { Stop: [SLEEP_STOP_GROUP, USER_STOP_GROUP] } });

    const result = withEndCheck();

    expect(result.migratedFromStop).toBe(true);
    expect(read(file).hooks.Stop).toEqual([USER_STOP_GROUP, END_CHECK_GROUP]);
  });

  it('leaves a settings file whose Stop is not a list untouched', () => {
    const file = seed({ hooks: { Stop: 'not a list' } });
    const before = fs.readFileSync(file, 'utf8');

    expect(withEndCheck().invalidJson).toBe(true);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('installJsonHooks(claude-code) without the end-check flag', () => {
  it('adds no Stop hook', () => {
    const result = installJsonHooks('claude-code');

    expect(result.installedEndCheck).toBe(false);
    expect(read(result.settingsPath).hooks.Stop).toBeUndefined();
  });

  it('keeps an end-check Stop hook an earlier install added', () => {
    withEndCheck();

    const again = installJsonHooks('claude-code');

    expect(again.installedEndCheck).toBe(false);
    expect(read(again.settingsPath).hooks.Stop).toEqual([END_CHECK_GROUP]);
  });

  it('does not add the hook back after the user removed it', () => {
    const { settingsPath } = withEndCheck();
    removeStopHook(settingsPath);

    expect(installJsonHooks('claude-code').installedEndCheck).toBe(false);

    expect(read(settingsPath).hooks.Stop).toBeUndefined();
  });

  it('migrates the old sleep Stop hook and adds no end check', () => {
    const file = seed({ hooks: { Stop: [SLEEP_STOP_GROUP, USER_STOP_GROUP] } });

    const result = installJsonHooks('claude-code');

    expect(result.migratedFromStop).toBe(true);
    expect(result.installedEndCheck).toBe(false);
    expect(read(file).hooks.Stop).toEqual([USER_STOP_GROUP]);
  });
});

describe('uninstallJsonHooks(claude-code) end check', () => {
  it('removes the end-check group and keeps a user Stop handler', () => {
    const file = seed({ hooks: { Stop: [USER_STOP_GROUP] } });
    withEndCheck();

    expect(uninstallJsonHooks('claude-code')).toBe(true);

    expect(read(file)).toEqual({ hooks: { Stop: [USER_STOP_GROUP] } });
  });

  it('removes the end-check group an install wrote and leaves no hooks key', () => {
    const { settingsPath } = withEndCheck();

    expect(uninstallJsonHooks('claude-code')).toBe(true);

    expect(read(settingsPath)).toEqual({});
  });
});

describe('hippo hook install --end-check', () => {
  it('prints the install line for claude-code and writes the Stop hook', async () => {
    const result = await runCliAs(['hook', 'install', 'claude-code', '--end-check'], { cwd: env.home });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installed hippo end-check Stop hook in claude-code settings');
    const { settings } = resolveJsonHookPaths('claude-code');
    expect(read(settings).hooks.Stop).toEqual([END_CHECK_GROUP]);
  });

  it('stops for a target that has no Stop hook to add, and writes nothing', async () => {
    const result = await runCliAs(['hook', 'install', 'codex', '--end-check'], { cwd: env.home });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('hippo hook install claude-code --end-check');
    expect(fs.existsSync(resolveJsonHookPaths('claude-code').settings)).toBe(false);
  });
});
