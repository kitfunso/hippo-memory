import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installJsonHooks,
  uninstallJsonHooks,
  resolveJsonHookPaths,
  detectInstalledTools,
  defaultSleepLogPath,
} from '../src/hooks.js';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json or ~/.config/opencode/opencode.json on the machine
 * running the tests.
 */
function withFakeHome(): { cleanup: () => void; home: string } {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hooks-test-'));
  process.env.HOME = fake;
  process.env.USERPROFILE = fake;
  return {
    home: fake,
    cleanup: () => {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(fake, { recursive: true, force: true });
    },
  };
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
    it('installs SessionEnd (sleep + capture) and SessionStart in a fresh settings.json', () => {
      const result = installJsonHooks('claude-code');

      expect(result.installedSessionEnd).toBe(true);
      expect(result.installedSessionStart).toBe(true);
      expect(result.installedSessionCapture).toBe(true);
      expect(result.migratedFromStop).toBe(false);
      expect(result.migratedLegacySessionEnd).toBe(false);

      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(2);
      expect(settings.hooks.SessionStart).toHaveLength(1);

      const sessionEndCmds = settings.hooks.SessionEnd.map(
        (e: { hooks: { command: string }[] }) => e.hooks[0].command
      );
      const sessionStartCmd = settings.hooks.SessionStart[0].hooks[0].command;
      expect(sessionEndCmds.some((c: string) => c.includes('hippo sleep --log-file'))).toBe(true);
      expect(sessionEndCmds.some((c: string) => c.includes('hippo capture --last-session'))).toBe(true);
      expect(sessionStartCmd).toContain('hippo last-sleep');
    });

    it('is idempotent -- running twice does not duplicate entries', () => {
      installJsonHooks('claude-code');
      const second = installJsonHooks('claude-code');

      expect(second.installedSessionEnd).toBe(false);
      expect(second.installedSessionStart).toBe(false);
      expect(second.installedSessionCapture).toBe(false);

      const settings = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(2);
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('adds the capture entry to a settings file that already has only the sleep SessionEnd', () => {
      // Simulates upgrading from 0.21.x (sleep-only) to 0.22.0 (sleep + capture).
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
            ],
          },
        }),
        'utf8',
      );

      const result = installJsonHooks('claude-code');

      expect(result.installedSessionEnd).toBe(false); // sleep already present
      expect(result.installedSessionCapture).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(2);
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
      expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('--log-file');
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

      expect(result.migratedLegacySessionEnd).toBe(true);
      expect(result.installedSessionEnd).toBe(true);
      expect(result.installedSessionCapture).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd).toHaveLength(2);
      const commands = settings.hooks.SessionEnd.map(
        (e: { hooks: { command: string }[] }) => e.hooks[0].command
      );
      expect(commands.some((c: string) => c.includes('--log-file'))).toBe(true);
      expect(commands.some((c: string) => c.includes('hippo capture --last-session'))).toBe(true);
      expect(commands.every((c: string) => !c.includes('echo'))).toBe(true);
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
      expect(settings.hooks.SessionEnd).toHaveLength(2); // sleep + capture
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

  describe('installJsonHooks(opencode)', () => {
    it('writes to ~/.config/opencode/opencode.json with the same schema', () => {
      const result = installJsonHooks('opencode');

      expect(result.installedSessionEnd).toBe(true);
      expect(result.installedSessionStart).toBe(true);
      expect(result.settingsPath).toMatch(/opencode[/\\]opencode\.json$/);

      const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
      expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain('hippo sleep --log-file');
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('hippo last-sleep');
    });

    it('uses a per-tool log path so claude-code and opencode do not collide', () => {
      const claudeResult = installJsonHooks('claude-code');
      const opencodeResult = installJsonHooks('opencode');

      const claudeCmd = JSON.parse(fs.readFileSync(claudeResult.settingsPath, 'utf8'))
        .hooks.SessionEnd[0].hooks[0].command as string;
      const opencodeCmd = JSON.parse(fs.readFileSync(opencodeResult.settingsPath, 'utf8'))
        .hooks.SessionEnd[0].hooks[0].command as string;

      expect(claudeCmd).toContain('claude-code-sleep.log');
      expect(opencodeCmd).toContain('opencode-sleep.log');
      expect(claudeCmd).not.toEqual(opencodeCmd);
    });
  });

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
      expect(tools.find((t) => t.name === 'opencode')?.kind).toBe('json-hook');
      expect(tools.find((t) => t.name === 'openclaw')?.kind).toBe('plugin');
      expect(tools.find((t) => t.name === 'codex')?.kind).toBe('markdown-instruction');
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
