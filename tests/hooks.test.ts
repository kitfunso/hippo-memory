import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installJsonHooks, uninstallJsonHooks, resolveJsonHookPaths } from '../src/hooks/json-hooks.js';
import { detectInstalledTools, defaultSleepLogPath, defaultPreCompactLogPath } from '../src/hooks/shared.js';
import { withFakeHome as withFakeHomeShared } from './_helpers/with-fake-home.js';
import type { JsonValue } from '../src/util/json.js';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json or ~/.config/opencode/opencode.json on the machine
 * running the tests. Delegates to the shared helper extracted 2026-05-23.
 */
function withFakeHome(): { cleanup: () => void; home: string } {
  return withFakeHomeShared('hippo-hooks-test-');
}

const PINNED_COMMAND = 'hippo context --pinned-only --include-recent 5 --format additional-context';
const USER_HANDLER = { type: 'command', command: 'node ~/hooks/redact.js' };
const LOOKALIKE_HANDLER = { type: 'command', command: 'echo bye; hippo sleep-report-of-mine' };

function seedRaw(text: string): string {
  const { settings } = resolveJsonHookPaths('claude-code');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, text, 'utf8');
  return settings;
}
const seedSettings = (settings: JsonValue): string => seedRaw(JSON.stringify(settings));
const readSettings = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('JSON hook installer', () => {
  let env: { cleanup: () => void; home: string };

  beforeEach(() => {
    env = withFakeHome();
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('installJsonHooks(claude-code)', () => {
    it('installs a single session-end SessionEnd and a last-sleep SessionStart in a fresh settings.json', () => {
      const result = installJsonHooks('claude-code');

      expect(result.installedSessionEnd).toBe(true);
      expect(result.installedSessionStart).toBe(true);
      expect(result.migratedFromStop).toBe(false);
      expect(result.migratedLegacySessionEnd).toBe(false);
      expect(result.migratedSplitSessionEnd).toBe(false);

      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(1);
      // SessionStart now carries two entries: the un-matched last-sleep
      // entry (index 0, asserted below) and the matcher:'compact'
      // compact-resume entry — see the dedicated PreCompact/compact-resume
      // test for that second entry's shape.
      expect(settings.hooks.SessionStart).toHaveLength(2);

      const sessionEndCmd = settings.hooks.SessionEnd[0].hooks[0].command;
      const sessionStartCmd = settings.hooks.SessionStart[0].hooks[0].command;
      expect(sessionEndCmd).toContain('hippo session-end --log-file');
      expect(sessionEndCmd).not.toContain('hippo sleep --log-file');
      expect(sessionEndCmd).not.toContain('hippo capture --last-session --log-file');
      expect(sessionStartCmd).toContain('hippo last-sleep');
    });

    it('uses a short SessionEnd timeout because the detached parent returns immediately', () => {
      const result = installJsonHooks('claude-code');
      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      const sessionEnd = settings.hooks.SessionEnd[0].hooks[0];
      expect(sessionEnd.timeout).toBeLessThanOrEqual(10);
    });

    it('installs a PreCompact hook and a matcher:"compact" SessionStart entry alongside last-sleep', () => {
      const result = installJsonHooks('claude-code');

      expect(result.installedPreCompact).toBe(true);
      expect(result.installedCompactResume).toBe(true);

      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      expect(settings.hooks.PreCompact).toHaveLength(1);
      expect(settings.hooks.PreCompact[0].matcher).toBeUndefined(); // fires on manual AND auto compaction
      const preCompactCmd = settings.hooks.PreCompact[0].hooks[0].command;
      expect(preCompactCmd).toContain('hippo pre-compact --log-file');
      expect(preCompactCmd).toContain(defaultPreCompactLogPath());

      // SessionStart now carries two entries: the pre-existing un-matched
      // last-sleep entry and the new matcher:'compact' compact-resume entry.
      expect(settings.hooks.SessionStart).toHaveLength(2);
      const compactEntry = settings.hooks.SessionStart.find(
        (e: { hooks: Array<{ command: string }> }) => e.hooks[0].command.includes('hippo compact-resume'),
      );
      expect(compactEntry).toBeDefined();
      expect(compactEntry.matcher).toBe('compact');
      const lastSleepEntry = settings.hooks.SessionStart.find(
        (e: { hooks: Array<{ command: string }> }) => e.hooks[0].command.includes('hippo last-sleep'),
      );
      expect(lastSleepEntry).toBeDefined();
      expect(lastSleepEntry.matcher).toBeUndefined();
    });

    it('is idempotent — running twice does not duplicate entries', () => {
      installJsonHooks('claude-code');
      const second = installJsonHooks('claude-code');

      expect(second.installedSessionEnd).toBe(false);
      expect(second.installedSessionStart).toBe(false);
      expect(second.installedPreCompact).toBe(false);
      expect(second.installedCompactResume).toBe(false);

      const settings = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(1);
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.PreCompact).toHaveLength(1);
    });

    it('migrates 0.22.x split sleep+capture SessionEnd entries into the single session-end entry', () => {
      // 0.22.x installed `hippo sleep --log-file` and `hippo capture --last-session --log-file`
      // as two separate SessionEnd entries. They ran in parallel and were
      // SIGTERM'd by TUI teardown before completion.
      const { settings: settingsPath, logFile } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionEnd: [
              {
                hooks: [
                  { type: 'command', command: `hippo sleep --log-file "${logFile}"`, timeout: 60 },
                ],
              },
              {
                hooks: [
                  { type: 'command', command: `hippo capture --last-session --log-file "${logFile}"`, timeout: 15 },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      const result = installJsonHooks('claude-code');

      expect(result.migratedSplitSessionEnd).toBe(true);
      expect(result.migratedLegacySessionEnd).toBe(true); // it was a multi-entry migration
      expect(result.installedSessionEnd).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(1);
      const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
      expect(cmd).toContain('hippo session-end --log-file');
      expect(cmd).not.toContain('hippo sleep --log-file');
      expect(cmd).not.toContain('hippo capture --last-session --log-file');
    });

    it('migrates a legacy Stop entry from versions < 0.20.2', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'hippo sleep 2>/dev/null || true', timeout: 30 },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      const result = installJsonHooks('claude-code');

      expect(result.migratedFromStop).toBe(true);
      expect(result.installedSessionEnd).toBe(true);
      expect(result.installedSessionStart).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.Stop).toBeUndefined();
      expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('hippo session-end');
    });

    it('migrates a legacy SessionEnd entry without --log-file', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: "echo '[hippo] consolidating memory...' && (hippo sleep && echo '[hippo] sleep complete' || echo '[hippo] sleep failed')",
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      const result = installJsonHooks('claude-code');

      expect(result.migratedSplitSessionEnd).toBe(true);
      expect(result.installedSessionEnd).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(1);
      const cmd = settings.hooks.SessionEnd[0].hooks[0].command;
      expect(cmd).toContain('hippo session-end --log-file');
      expect(cmd).not.toContain('echo');
    });

    it('preserves unrelated hooks in other event keys', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'some-other-guard.js', timeout: 5 }],
              },
            ],
          },
        }),
        'utf8',
      );

      installJsonHooks('claude-code');

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('some-other-guard.js');
      expect(settings.hooks.SessionEnd).toHaveLength(1);
    });

    it('ignores an unparseable settings.json without throwing', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ not valid json', 'utf8');

      const result = installJsonHooks('claude-code');

      expect(result.installedSessionEnd).toBe(false);
      expect(result.installedSessionStart).toBe(false);
      expect(result.installedPreCompact).toBe(false);
      expect(result.installedCompactResume).toBe(false);
    });
  });

  // The former 'installJsonHooks(opencode)' describe block was removed
  // 2026-05-23 when opencode flipped from JSON-hook integration to a TS plugin.
  // Coverage for the new plugin installer lives in
  // tests/opencode-plugin-install.test.ts.

  describe('uninstallJsonHooks', () => {
    it('removes SessionEnd, SessionStart, and legacy Stop entries', () => {
      installJsonHooks('claude-code');
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');

      // Add a legacy Stop entry alongside the current ones.
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.hooks.Stop = [
        { hooks: [{ type: 'command', command: 'hippo sleep 2>/dev/null', timeout: 30 }] },
      ];
      fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');

      const removed = uninstallJsonHooks('claude-code');
      expect(removed).toBe(true);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(after.hooks?.SessionEnd).toBeUndefined();
      expect(after.hooks?.SessionStart).toBeUndefined();
      expect(after.hooks?.PreCompact).toBeUndefined();
      expect(after.hooks?.Stop).toBeUndefined();
    });

    it('removes PreCompact and the matcher-carrying compact-resume SessionStart entry, having left the un-matched last-sleep entry intact through install', () => {
      installJsonHooks('claude-code');
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');

      // Sanity on the fixture: a fresh install left last-sleep (no matcher)
      // and compact-resume (matcher: 'compact') coexisting, unmodified, in
      // the same SessionStart array before uninstall runs.
      const before = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(before.hooks.SessionStart).toHaveLength(2);
      const lastSleepBefore = before.hooks.SessionStart.find(
        (e: { matcher?: string }) => e.matcher === undefined,
      );
      expect(lastSleepBefore.hooks[0].command).toContain('hippo last-sleep');
      expect(lastSleepBefore.matcher).toBeUndefined();

      const removed = uninstallJsonHooks('claude-code');
      expect(removed).toBe(true);

      // Full uninstall tears down every hippo-owned entry — including
      // last-sleep — regardless of which entries carry a matcher field, so
      // the matcher-carrying compact-resume entry doesn't corrupt removal
      // of its un-matched sibling.
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(after.hooks?.PreCompact).toBeUndefined();
      expect(after.hooks?.SessionStart).toBeUndefined();
    });

    it('also removes legacy 0.22.x split sleep+capture SessionEnd entries', () => {
      const { settings: settingsPath, logFile } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionEnd: [
              { hooks: [{ type: 'command', command: `hippo sleep --log-file "${logFile}"`, timeout: 60 }] },
              { hooks: [{ type: 'command', command: `hippo capture --last-session --log-file "${logFile}"`, timeout: 15 }] },
            ],
          },
        }),
        'utf8',
      );

      const removed = uninstallJsonHooks('claude-code');
      expect(removed).toBe(true);

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(after.hooks?.SessionEnd).toBeUndefined();
    });

    it('returns false when nothing needs removing', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), 'utf8');

      expect(uninstallJsonHooks('claude-code')).toBe(false);
    });

    it('leaves unrelated hooks untouched', () => {
      const { settings: settingsPath } = resolveJsonHookPaths('claude-code');
      installJsonHooks('claude-code');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.hooks.PreToolUse = [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'some-unrelated-hook', timeout: 5 }],
        },
      ];
      fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');

      uninstallJsonHooks('claude-code');

      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(after.hooks.PreToolUse).toHaveLength(1);
      expect(after.hooks.PreToolUse[0].hooks[0].command).toBe('some-unrelated-hook');
    });
  });

  describe('uninstallJsonHooks removes one handler at a time (claude-code)', () => {
    it("keeps a user's handler that shares a group with hippo's, and keeps the group", () => {
      const file = seedSettings({
        hooks: { UserPromptSubmit: [{ hooks: [USER_HANDLER, { type: 'command', command: PINNED_COMMAND }] }] },
      });

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      expect(readSettings(file)).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [USER_HANDLER] }] } });
    });

    it.each([
      ['SessionEnd', 'echo bye; hippo sleep-report-of-mine'],
      ['SessionEnd', 'myhippo session-end --log-file x'],
      ['SessionStart', 'hippo last-sleeper'],
      ['UserPromptSubmit', 'hippo context --pinned-only-report'],
      ['PreCompact', 'hippo pre-compact2'],
    ])("keeps a user's %s command that only contains a hippo command name: %s", (event, command) => {
      const settings = { hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] } };
      const file = seedSettings(settings);

      expect(uninstallJsonHooks('claude-code')).toBe(false);

      expect(readSettings(file)).toEqual(settings);
    });

    it('drops a group of only hippo handlers, and an event key once it has no group left', () => {
      const userGroup = { hooks: [USER_HANDLER] };
      const file = seedSettings({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: 'command', command: 'hippo session-end --log-file "x"' }, { type: 'command', command: 'hippo sleep' }] },
            userGroup,
          ],
          PostCompact: [{ hooks: [{ type: 'command', command: 'hippo post-compact --log-file "x"' }] }],
        },
      });

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      expect(readSettings(file)).toEqual({ hooks: { SessionEnd: [userGroup] } });
    });

    it('removes every command install writes, leaving no hooks key', () => {
      const result = installJsonHooks('claude-code');
      const events = Object.keys(readSettings(result.settingsPath).hooks).sort();
      expect(events).toEqual(['PostCompact', 'PostToolUseFailure', 'PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      expect(readSettings(result.settingsPath)).toEqual({});
    });

    it("removes the matcher-scoped compact-resume group and keeps a user's SessionStart group", () => {
      installJsonHooks('claude-code');
      const { settings: file } = resolveJsonHookPaths('claude-code');
      const userGroup = { matcher: 'startup', hooks: [USER_HANDLER] };
      const settings = readSettings(file);
      settings.hooks.SessionStart.push(userGroup);
      fs.writeFileSync(file, JSON.stringify(settings), 'utf8');

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      expect(readSettings(file)).toEqual({ hooks: { SessionStart: [userGroup] } });
    });

    it("keeps a group's matcher while a user handler is left in it", () => {
      const file = seedSettings({
        hooks: { SessionStart: [{ matcher: 'compact', hooks: [USER_HANDLER, { type: 'command', command: 'hippo compact-resume', timeout: 10 }] }] },
      });

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      expect(readSettings(file)).toEqual({ hooks: { SessionStart: [{ matcher: 'compact', hooks: [USER_HANDLER] }] } });
    });

    it('leaves groups and handlers of an unexpected shape untouched', () => {
      const odd: JsonValue = {
        SessionEnd: [
          'hippo sleep',
          { command: 'hippo sleep' },
          { hooks: 'hippo sleep' },
          { hooks: [null, 'hippo sleep', { type: 'command' }, { type: 'command', command: 42 }] },
        ],
      };
      const file = seedSettings({ hooks: odd });

      expect(uninstallJsonHooks('claude-code')).toBe(false);

      expect(readSettings(file)).toEqual({ hooks: odd });
    });
  });

  describe('installJsonHooks(claude-code) migrations keep a handler that is not hippo\'s', () => {
    it('Stop: removes hippo sleep from a group it shares, keeping the user handler', () => {
      const file = seedSettings({
        hooks: { Stop: [{ hooks: [USER_HANDLER, { type: 'command', command: 'hippo sleep 2>/dev/null || true', timeout: 30 }] }] },
      });

      const result = installJsonHooks('claude-code');

      expect(result.migratedFromStop).toBe(true);
      expect(readSettings(file).hooks.Stop).toEqual([{ hooks: [USER_HANDLER] }]);
    });

    it('Stop: keeps a command that only contains hippo sleep', () => {
      const file = seedSettings({ hooks: { Stop: [{ hooks: [LOOKALIKE_HANDLER] }] } });

      const result = installJsonHooks('claude-code');

      expect(result.migratedFromStop).toBe(false);
      expect(readSettings(file).hooks.Stop).toEqual([{ hooks: [LOOKALIKE_HANDLER] }]);
    });

    it('SessionEnd: removes legacy sleep and capture handlers from a group they share, keeping the user handler', () => {
      const file = seedSettings({
        hooks: {
          SessionEnd: [{
            hooks: [
              USER_HANDLER,
              { type: 'command', command: 'hippo sleep --log-file "x"', timeout: 60 },
              { type: 'command', command: 'hippo capture --last-session --log-file "x"', timeout: 15 },
            ],
          }],
        },
      });

      const result = installJsonHooks('claude-code');

      expect(result.migratedSplitSessionEnd).toBe(true);
      const sessionEnd = readSettings(file).hooks.SessionEnd;
      expect(sessionEnd).toHaveLength(2);
      expect(sessionEnd[0]).toEqual({ hooks: [USER_HANDLER] });
      expect(sessionEnd[1].hooks[0].command).toContain('hippo session-end --log-file');
    });

    it('SessionEnd: keeps a command that only contains hippo sleep, and reports no migration', () => {
      const file = seedSettings({ hooks: { SessionEnd: [{ hooks: [LOOKALIKE_HANDLER] }] } });

      const result = installJsonHooks('claude-code');

      expect(result.migratedSplitSessionEnd).toBe(false);
      expect(readSettings(file).hooks.SessionEnd[0]).toEqual({ hooks: [LOOKALIKE_HANDLER] });
    });
  });

  describe('CLAUDE_CONFIG_DIR', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    afterEach(() => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    });

    it('moves the claude-code settings there, for install and for uninstall', () => {
      const config = fs.mkdtempSync(path.join(env.home, 'claude-config-'));
      process.env.CLAUDE_CONFIG_DIR = config;
      const settingsPath = path.join(config, 'settings.json');
      expect(resolveJsonHookPaths('claude-code').settings).toBe(settingsPath);

      expect(installJsonHooks('claude-code').settingsPath).toBe(settingsPath);
      expect(fs.existsSync(path.join(env.home, '.claude', 'settings.json'))).toBe(false);
      expect(readSettings(settingsPath).hooks.SessionEnd).toHaveLength(1);

      expect(uninstallJsonHooks('claude-code')).toBe(true);
      expect(readSettings(settingsPath)).toEqual({});
    });

    it.each([['unset', undefined], ['empty', '']])('keeps ~/.claude when it is %s', (_label, value) => {
      if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = value;

      expect(resolveJsonHookPaths('claude-code').settings).toBe(path.join(env.home, '.claude', 'settings.json'));
    });

    // Claude Code finds ~/.claude through os.homedir() (USERPROFILE on Windows, HOME elsewhere), so the other variable, as Git Bash sets it, must not move hippo's edit.
    it('keeps ~/.claude under os.homedir() when the other home variable points elsewhere', () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env[process.platform === 'win32' ? 'HOME' : 'USERPROFILE'] = fs.mkdtempSync(path.join(env.home, 'stray-'));
      const expected = path.join(os.homedir(), '.claude');

      expect(expected).toBe(path.join(env.home, '.claude'));
      expect(resolveJsonHookPaths('claude-code').settings).toBe(path.join(expected, 'settings.json'));
      fs.mkdirSync(expected);
      expect(detectInstalledTools().find((t) => t.name === 'claude-code')).toMatchObject({ detected: true, configDir: expected });
    });

    it('makes detectInstalledTools look there for Claude Code', () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(env.home, 'elsewhere');
      expect(detectInstalledTools().find((t) => t.name === 'claude-code')?.detected).toBe(false);

      fs.mkdirSync(path.join(env.home, 'elsewhere'));
      expect(detectInstalledTools().find((t) => t.name === 'claude-code')?.detected).toBe(true);
    });
  });

  describe('a settings.json saved with a UTF-8 byte order mark (Windows PowerShell 5.1)', () => {
    const BOM = String.fromCodePoint(0xfeff);

    it("uninstall removes hippo's handlers, keeps the user's, and rewrites the file without the mark", () => {
      const file = seedRaw(BOM + JSON.stringify({
        theme: 'dark',
        hooks: { SessionEnd: [{ hooks: [USER_HANDLER, { type: 'command', command: 'hippo session-end --log-file "x"' }] }] },
      }));

      expect(uninstallJsonHooks('claude-code')).toBe(true);

      const raw = fs.readFileSync(file, 'utf8');
      expect(raw.startsWith(BOM)).toBe(false);
      expect(JSON.parse(raw)).toEqual({ theme: 'dark', hooks: { SessionEnd: [{ hooks: [USER_HANDLER] }] } });
    });

    it('install adds the hooks, keeps the user settings, and writes the file without the mark', () => {
      const file = seedRaw(BOM + JSON.stringify({ theme: 'dark' }));

      const result = installJsonHooks('claude-code');

      expect(result.invalidJson).toBe(false);
      expect(result.installedSessionEnd).toBe(true);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw.startsWith(BOM)).toBe(false);
      expect(JSON.parse(raw).theme).toBe('dark');
      expect(JSON.parse(raw).hooks.SessionEnd).toHaveLength(1);
    });
  });

  describe('writing settings.json', () => {
    const seedForStep = (step: string): string => seedSettings(step === 'install' ? { theme: 'dark' } : {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file "x"' }] }] },
    });
    const runStep = (step: string): void => {
      if (step === 'install') installJsonHooks('claude-code');
      else uninstallJsonHooks('claude-code');
    };

    // A new file number means the write swapped a finished file in instead of truncating the old one.
    it.each(['install', 'uninstall'])('%s replaces the file whole, so a crash mid-write cannot truncate it', (step) => {
      const file = seedForStep(step);
      const before = fs.readFileSync(file, 'utf8');
      const inode = fs.statSync(file, { bigint: true }).ino;

      runStep(step);

      expect(fs.readFileSync(file, 'utf8')).not.toBe(before);
      expect(fs.statSync(file, { bigint: true }).ino).not.toBe(inode);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
    });

    // A rename would give the file a new inode and leave the other link on the old content.
    it.each(['install', 'uninstall'])('%s writes a hard-linked file in place, so every link sees the new content', (step) => {
      const file = seedForStep(step);
      const before = fs.readFileSync(file, 'utf8');
      const link = path.join(path.dirname(file), 'settings.link');
      fs.linkSync(file, link);

      runStep(step);

      expect(fs.readFileSync(file, 'utf8')).not.toBe(before);
      expect(fs.readFileSync(link, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
      expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['settings.json', 'settings.link']);
    });

    it('writes through a symlinked settings.json and leaves the link in place', (ctx) => {
      const real = path.join(env.home, 'dotfiles', 'settings.json');
      fs.mkdirSync(path.dirname(real), { recursive: true });
      fs.writeFileSync(real, '{}\n', 'utf8');
      const { settings: link } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(real, link);
      } catch {
        ctx.skip(); // creating a symlink needs a privilege some Windows boxes lack
      }

      installJsonHooks('claude-code');

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readSettings(real).hooks.SessionEnd).toHaveLength(1);
    });

    // The link points into a folder that does not exist yet, as a dotfile manager leaves it before its first checkout.
    it('writes through a dangling symlink, creating the folder it points into', (ctx) => {
      const real = path.join(env.home, 'dotfiles', 'claude', 'settings.json');
      const { settings: link } = resolveJsonHookPaths('claude-code');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try {
        fs.symlinkSync(real, link);
      } catch {
        ctx.skip(); // creating a symlink needs a privilege some Windows boxes lack
      }

      installJsonHooks('claude-code');

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readSettings(real).hooks.SessionEnd).toHaveLength(1);
    });

    it.skipIf(process.platform === 'win32')('keeps the file mode, so a private settings.json stays private', () => {
      const file = seedSettings({ env: { SECRET: 'x' } });
      fs.chmodSync(file, 0o600);

      installJsonHooks('claude-code');

      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    // The umask trims the mode a new file is created with, so only a chmod after the write restores 0664.
    it.skipIf(process.platform === 'win32')('keeps a group-writable mode through a restrictive umask', () => {
      const file = seedSettings({ theme: 'dark' });
      fs.chmodSync(file, 0o664);
      const previous = process.umask(0o077);

      try {
        installJsonHooks('claude-code');
      } finally {
        process.umask(previous);
      }

      expect(fs.statSync(file).mode & 0o777).toBe(0o664);
    });
  });

  describe('detectInstalledTools', () => {
    it('reports claude-code as detected when ~/.claude exists', () => {
      fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
      const tools = detectInstalledTools();
      const claude = tools.find((t) => t.name === 'claude-code');
      expect(claude?.detected).toBe(true);
    });

    it('reports opencode as not detected by default', () => {
      const tools = detectInstalledTools();
      const opencode = tools.find((t) => t.name === 'opencode');
      expect(opencode?.detected).toBe(false);
    });

    it('reports opencode as detected when ~/.config/opencode exists', () => {
      fs.mkdirSync(path.join(env.home, '.config', 'opencode'), { recursive: true });
      const tools = detectInstalledTools();
      const opencode = tools.find((t) => t.name === 'opencode');
      expect(opencode?.detected).toBe(true);
    });

    it('classifies tool kinds correctly', () => {
      const tools = detectInstalledTools();
      expect(tools.find((t) => t.name === 'claude-code')?.kind).toBe('json-hook');
      expect(tools.find((t) => t.name === 'opencode')?.kind).toBe('plugin');
      expect(tools.find((t) => t.name === 'openclaw')?.kind).toBe('plugin');
      expect(tools.find((t) => t.name === 'codex')?.kind).toBe('wrapper');
      expect(tools.find((t) => t.name === 'cursor')?.kind).toBe('markdown-instruction');
      expect(tools.find((t) => t.name === 'pi')?.kind).toBe('markdown-instruction');
    });
  });

  describe('defaultSleepLogPath', () => {
    it('returns a path inside ~/.hippo/logs/', () => {
      const p = defaultSleepLogPath();
      expect(p).toContain(path.join('.hippo', 'logs'));
      expect(p.endsWith('last-sleep.log')).toBe(true);
    });
  });
});
