// Pins the whole settings.json the Claude Code installer leaves behind, from a legacy file and from nothing, so splitting installJsonHooks cannot reorder or drop an entry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { COMMANDS } from '../src/cli/verbs.js';
import { undeclaredFlags, type VerbFlags } from '../src/cli/flags.js';
import { HOOKS } from '../src/hooks/hook-blocks.js';
import { installJsonHooks, resolveJsonHookPaths } from '../src/hooks/json-hooks.js';
import { installOpencodePlugin, resolveOpencodePluginPath } from '../src/hooks/opencode.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';

let env: FakeHomeHandle;

beforeEach(() => {
  env = withFakeHome('hippo-hooks-shape-');
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.cleanup();
});

/** Settings with the fake home folded to `~` and separators unified, so the shape reads the same on every OS. */
function settingsAsWritten(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(JSON.stringify(env.home).slice(1, -1)).join('~').replace(/\\\\/g, '/');
}

/** Every JSON string in a hooks file that runs hippo, whatever key holds it, so a new hook form is covered unnamed. */
function hippoCommandsIn(file: string): string[] {
  const strings = [...fs.readFileSync(file, 'utf8').matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => String(JSON.parse(m[0])));
  return strings.filter((text) => /^hippo(\.cmd)? /.test(text));
}

/** A hook line as argv: cut at the first shell operator, then split on spaces outside quotes. */
function hookArgv(line: string): string[] {
  const command = line.split(/\s(?:2>|\|\||&&|<<<)/)[0];
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

describe('first-party hook command lines', () => {
  it('pass only flags their verb declares, so no hook hippo installs prints the ignored-flag warning', () => {
    for (const name of ['CODEX_HOME', 'COPILOT_HOME', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(name, '');
    const lines: string[] = [];
    for (const target of ['claude-code', 'codex', 'copilot'] as const) {
      const { settings } = resolveJsonHookPaths(target);
      expect(settings.startsWith(env.home)).toBe(true);
      installJsonHooks(target);
      lines.push(...hippoCommandsIn(settings));
    }
    lines.push(...hippoCommandsIn(path.resolve(__dirname, '..', 'extensions', 'claude-code-plugin', 'hooks', 'hooks.json')));
    installOpencodePlugin();
    const opencodePlugin = fs.readFileSync(resolveOpencodePluginPath(), 'utf8');
    for (const text of [...Object.values(HOOKS).map((hook) => hook.content), opencodePlugin]) {
      lines.push(...[...text.matchAll(/(?:^|\$`)(hippo [^\n`]+)/gm)].map((m) => m[1]));
    }

    const rows: Record<string, { readonly flags: VerbFlags }> = COMMANDS;
    const verbs = new Set<string>();
    const ignored = lines.flatMap((line) => {
      const { command, flags } = parseArgs(['node', 'hippo', ...hookArgv(line).slice(1)]);
      verbs.add(command);
      const row = rows[command];
      return row ? undeclaredFlags(row.flags, Object.keys(flags)).map((flag) => `${line}: --${flag}`) : [`${line}: no such verb`];
    });

    expect(ignored).toEqual([]);
    expect([...verbs].sort()).toEqual([
      'capture', 'capture-error', 'compact-resume', 'context', 'last-sleep', 'post-compact', 'pre-compact', 'recall', 'remember',
      'session-end',
    ]);
  });
});

describe('installJsonHooks(claude-code) settings shape', () => {
  it('migrates a legacy file in one write and keeps the user hooks in place', () => {
    const { settings } = resolveJsonHookPaths('claude-code');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      theme: 'dark',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'hippo sleep' }] },
          { hooks: [{ type: 'command', command: 'echo user-stop' }] },
        ],
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'hippo sleep --log-file "x.log"' }] },
          { hooks: [{ type: 'command', command: 'hippo capture --last-session --log-file "x.log"' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'hippo context --pinned-only --format additional-context', timeout: 5 }] },
        ],
      },
    }), 'utf8');

    const first = installJsonHooks('claude-code');
    expect({ ...first, settingsPath: path.relative(env.home, first.settingsPath).replace(/\\/g, '/') }).toMatchInlineSnapshot(`
      {
        "installedCaptureError": true,
        "installedCompactResume": true,
        "installedPostCompact": true,
        "installedPreCompact": true,
        "installedSessionEnd": true,
        "installedSessionStart": true,
        "installedUserPromptSubmit": false,
        "invalidJson": false,
        "migratedFromStop": true,
        "migratedLegacySessionEnd": true,
        "migratedPinnedInjectRecent": true,
        "migratedSplitSessionEnd": true,
        "settingsPath": ".claude/settings.json",
        "target": "claude-code",
      }
    `);
    expect(settingsAsWritten(settings)).toMatchInlineSnapshot(`
      "{
        "theme": "dark",
        "hooks": {
          "Stop": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "echo user-stop"
                }
              ]
            }
          ],
          "UserPromptSubmit": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo context --pinned-only --include-recent 5 --format additional-context",
                  "timeout": 5
                }
              ]
            }
          ],
          "SessionEnd": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo session-end --log-file \\"~/.hippo/logs/claude-code-sleep.log\\"",
                  "timeout": 5
                }
              ]
            }
          ],
          "SessionStart": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo last-sleep --path \\"~/.hippo/logs/claude-code-sleep.log\\"",
                  "timeout": 5
                }
              ]
            },
            {
              "matcher": "compact",
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo compact-resume",
                  "timeout": 10
                }
              ]
            }
          ],
          "PreCompact": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo pre-compact --log-file \\"~/.hippo/logs/pre-compact.log\\"",
                  "timeout": 30
                }
              ]
            }
          ],
          "PostCompact": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo post-compact --log-file \\"~/.hippo/logs/pre-compact.log\\"",
                  "timeout": 10
                }
              ]
            }
          ],
          "PostToolUseFailure": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo capture-error",
                  "timeout": 10
                }
              ]
            }
          ]
        }
      }
      "
    `);

    const before = fs.readFileSync(settings, 'utf8');
    const second = installJsonHooks('claude-code');
    expect(Object.entries(second).filter(([, v]) => v === true)).toEqual([]);
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
  });

  it('reports invalid JSON without writing, and builds a fresh file from nothing', () => {
    const { settings } = resolveJsonHookPaths('claude-code');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ not json', 'utf8');
    expect(installJsonHooks('claude-code').invalidJson).toBe(true);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ not json');

    fs.rmSync(path.dirname(settings), { recursive: true, force: true });
    installJsonHooks('claude-code');
    expect(settingsAsWritten(settings)).toMatchInlineSnapshot(`
      "{
        "hooks": {
          "SessionEnd": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo session-end --log-file \\"~/.hippo/logs/claude-code-sleep.log\\"",
                  "timeout": 5
                }
              ]
            }
          ],
          "SessionStart": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo last-sleep --path \\"~/.hippo/logs/claude-code-sleep.log\\"",
                  "timeout": 5
                }
              ]
            },
            {
              "matcher": "compact",
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo compact-resume",
                  "timeout": 10
                }
              ]
            }
          ],
          "UserPromptSubmit": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo context --pinned-only --include-recent 5 --format additional-context",
                  "timeout": 5
                }
              ]
            }
          ],
          "PreCompact": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo pre-compact --log-file \\"~/.hippo/logs/pre-compact.log\\"",
                  "timeout": 30
                }
              ]
            }
          ],
          "PostCompact": [
            {
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo post-compact --log-file \\"~/.hippo/logs/pre-compact.log\\"",
                  "timeout": 10
                }
              ]
            }
          ],
          "PostToolUseFailure": [
            {
              "matcher": ".*",
              "hooks": [
                {
                  "type": "command",
                  "command": "hippo capture-error",
                  "timeout": 10
                }
              ]
            }
          ]
        }
      }
      "
    `);
  });
});
