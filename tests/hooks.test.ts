import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installJsonHooks,
  uninstallJsonHooks,
  resolveJsonHookPaths,
  detectInstalledTools,
  defaultSleepLogPath,
} from '../src/hooks.js';
import { withFakeHome as withFakeHomeShared } from './_helpers/with-fake-home.js';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json or ~/.config/opencode/opencode.json on the machine
 * running the tests. Delegates to the shared helper extracted 2026-05-23.
 */
function withFakeHome(): { cleanup: () => void; home: string } {
  return withFakeHomeShared('hippo-hooks-test-');
}

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
      expect(settings.hooks.SessionStart).toHaveLength(1);

      const sessionEndCmd = settings.hooks.SessionEnd[0].hooks[0].command as string;
      const sessionStartCmd = settings.hooks.SessionStart[0].hooks[0].command as string;
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

    it('is idempotent — running twice does not duplicate entries', () => {
      installJsonHooks('claude-code');
      const second = installJsonHooks('claude-code');

      expect(second.installedSessionEnd).toBe(false);
      expect(second.installedSessionStart).toBe(false);

      const settings = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(1);
      expect(settings.hooks.SessionStart).toHaveLength(1);
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
      const cmd = settings.hooks.SessionEnd[0].hooks[0].command as string;
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
                    command: "echo '[hippo] consolidating...' && hippo sleep",
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
      const cmd = settings.hooks.SessionEnd[0].hooks[0].command as string;
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
      expect(after.hooks?.Stop).toBeUndefined();
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
