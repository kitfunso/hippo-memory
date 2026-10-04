// Pins the whole settings.json the Claude Code installer leaves behind, from a legacy file and from nothing, so splitting installJsonHooks cannot reorder or drop an entry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installJsonHooks, resolveJsonHookPaths } from '../src/hooks.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';

let env: FakeHomeHandle;

beforeEach(() => {
  env = withFakeHome('hippo-hooks-shape-');
});

afterEach(() => {
  env.cleanup();
});

/** Settings with the fake home folded to `~` and separators unified, so the shape reads the same on every OS. */
function settingsAsWritten(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split(JSON.stringify(env.home).slice(1, -1)).join('~').replace(/\\\\/g, '/');
}

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
