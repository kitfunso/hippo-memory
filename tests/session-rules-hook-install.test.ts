// The SessionStart hook that sends the user's rules: install adds it once with no matcher, beside any hook already
// there, and uninstall takes out only hippo's own handler. A fake HOME keeps the real settings.json out of it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installJsonHooks,
  resolveJsonHookPaths,
  uninstallJsonHooks,
} from '../src/hooks/json-hooks.js';
import type { JsonValue } from '../src/util/json.js';
import { withFakeHome } from './_helpers/with-fake-home.js';

const RULES_COMMAND = 'hippo session-rules';
const USER_HANDLER = { type: 'command', command: 'node ~/hooks/redact.js' };

type Group = { hooks: Array<{ command: string }> };

let env: { cleanup: () => void; home: string };

beforeEach(() => {
  env = withFakeHome('hippo-session-rules-install-');
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
const rulesGroups = (file: string): Group[] =>
  read(file).hooks.SessionStart.filter((g: Group) => g.hooks.some((h) => h.command === RULES_COMMAND));

describe('installJsonHooks(claude-code) session-rules', () => {
  it('adds the hook with no matcher, and a second install adds no second one', () => {
    const first = installJsonHooks('claude-code');
    expect(first.installedSessionRules).toBe(true);
    expect(rulesGroups(first.settingsPath)).toEqual([
      { hooks: [{ type: 'command', command: RULES_COMMAND, timeout: 5 }] },
    ]);

    const second = installJsonHooks('claude-code');
    expect(second.installedSessionRules).toBe(false);
    expect(rulesGroups(second.settingsPath)).toHaveLength(1);
  });

  it('adds it beside a last-sleep hook an earlier release installed, which stays first', () => {
    const lastSleep = { hooks: [{ type: 'command', command: 'hippo last-sleep', timeout: 5 }] };
    const file = seed({ hooks: { SessionStart: [lastSleep] } });

    const result = installJsonHooks('claude-code');

    expect(result.installedSessionRules).toBe(true);
    expect(result.installedSessionStart).toBe(false);
    expect(read(file).hooks.SessionStart[0]).toEqual(lastSleep);
  });
});

describe('uninstallJsonHooks(claude-code) session-rules', () => {
  it('removes the hook and leaves a user handler in the same group', () => {
    const file = seed({
      hooks: { SessionStart: [{ hooks: [USER_HANDLER, { type: 'command', command: RULES_COMMAND, timeout: 5 }] }] },
    });

    expect(uninstallJsonHooks('claude-code')).toBe(true);

    expect(read(file)).toEqual({ hooks: { SessionStart: [{ hooks: [USER_HANDLER] }] } });
  });

  it('removes the hook an install wrote and leaves no hooks key', () => {
    const { settingsPath } = installJsonHooks('claude-code');

    expect(uninstallJsonHooks('claude-code')).toBe(true);

    expect(read(settingsPath)).toEqual({});
  });
});
