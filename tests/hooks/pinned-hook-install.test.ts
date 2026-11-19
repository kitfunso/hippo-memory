import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetInstalledHooks,
  installJsonHooks,
  uninstallJsonHooks,
} from '../../src/surface/hooks-install/json-hooks.js';
import {
  HIPPO_CAPTURE_ERROR_MARKER,
  HIPPO_COMPACT_RESUME_MARKER,
  HIPPO_LAST_SLEEP_MARKER,
  HIPPO_NOTE_WRITTEN_MARKER,
  HIPPO_PINNED_INJECT_MARKER,
  HIPPO_POST_COMPACT_MARKER,
  HIPPO_PRE_COMPACT_MARKER,
  HIPPO_SESSION_END_MARKER,
  HIPPO_SESSION_RULES_MARKER,
} from '../../src/surface/hooks-install/rules/shared.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Tests for the mid-session pinned-rule re-injection hook.
 *
 * Phase C of docs/plans/2026-04-21-pinned-reinject.md: `installJsonHooks`
 * must add a UserPromptSubmit entry that invokes
 * `hippo context --pinned-only --include-recent 5 --format additional-context`
 * every turn, so pinned memories and fresh same-session writes survive long
 * sessions where the model would otherwise "forget" them.
 *
 * We override HOME + USERPROFILE to redirect `homeDir()` in src/hooks.ts to
 * a tmp directory — no signature change on installJsonHooks/uninstallJsonHooks.
 */
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hookinst-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('HOME', tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('installJsonHooks — UserPromptSubmit pinned-inject (claude-code)', () => {
  it('adds a UserPromptSubmit entry calling hippo context --pinned-only', () => {
    const result = installJsonHooks('claude-code');
    expect(result.installedUserPromptSubmit).toBe(true);

    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    const entries = settings.hooks.UserPromptSubmit;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    const flat = JSON.stringify(entries);
    expect(flat).toContain('hippo context --pinned-only');
    expect(flat).toContain('--include-recent 5');
    expect(flat).toContain('--format additional-context');
  });

  it('is idempotent — second call does not add a duplicate UserPromptSubmit entry', () => {
    installJsonHooks('claude-code');
    const second = installJsonHooks('claude-code');
    expect(second.installedUserPromptSubmit).toBe(false);

    const settings = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('migrates the legacy pinned-only hook to include the fresh write tail', () => {
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'hippo context --pinned-only --format additional-context',
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const result = installJsonHooks('claude-code');
    expect(result.installedUserPromptSubmit).toBe(false);
    expect(result.migratedPinnedInjectRecent).toBe(true);

    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    const flat = JSON.stringify(settings.hooks.UserPromptSubmit);
    expect(flat).toContain('hippo context --pinned-only --include-recent 5 --format additional-context');
  });

  it('migration edits only a hippo handler: a user command that merely mentions the pinned-only command is left as written', () => {
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const mine = {
      type: 'command',
      command: 'node ~/hooks/ctx.js --note "hippo context --pinned-only-report" --format json',
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [mine] }] } }));

    const result = installJsonHooks('claude-code');
    expect(result.migratedPinnedInjectRecent).toBe(false);
    // The install test is the loose substring one, so a mention counts as installed and nothing is appended.
    expect(result.installedUserPromptSubmit).toBe(false);

    const groups = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.UserPromptSubmit;
    expect(groups).toEqual([{ hooks: [mine] }]);
  });

  it('migration edits the hippo handler of a group it shares with a user handler, and only that one', () => {
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const mine = { type: 'command', command: 'node ~/hooks/redact.js --format json' };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                mine,
                { type: 'command', command: 'hippo context --pinned-only --format additional-context', timeout: 5 },
              ],
            },
          ],
        },
      }),
    );

    const result = installJsonHooks('claude-code');
    expect(result.migratedPinnedInjectRecent).toBe(true);

    const groups = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.UserPromptSubmit;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0]).toEqual(mine);
    expect(groups[0].hooks[1].command).toBe(
      'hippo context --pinned-only --include-recent 5 --format additional-context',
    );
  });

  it('uninstallJsonHooks removes the UserPromptSubmit pinned-inject entry', () => {
    installJsonHooks('claude-code');
    const removed = uninstallJsonHooks('claude-code');
    expect(removed).toBe(true);

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const remaining = settings.hooks?.UserPromptSubmit ?? [];
    expect(remaining).toHaveLength(0);
  });
});

describe('installJsonHooks(claude-code) and the record of installed hooks', () => {
  const settingsFile = () => path.join(tmpHome, '.claude', 'settings.json');
  const recordFile = () => path.join(tmpHome, '.hippo', 'installed-hooks.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  const ALL_MARKERS = [
    HIPPO_SESSION_END_MARKER,
    HIPPO_LAST_SLEEP_MARKER,
    HIPPO_SESSION_RULES_MARKER,
    HIPPO_PINNED_INJECT_MARKER,
    HIPPO_PRE_COMPACT_MARKER,
    HIPPO_COMPACT_RESUME_MARKER,
    HIPPO_POST_COMPACT_MARKER,
    HIPPO_CAPTURE_ERROR_MARKER,
    HIPPO_NOTE_WRITTEN_MARKER,
  ];
  type Handler = { type: string; command: string; args: string[] };
  // The stock prompt hook is the one users swap for their own wrapper, so it is the hook removed here.
  function removePinnedInject(wrapper?: Handler): void {
    const settings = readSettings();
    if (wrapper) settings.hooks.UserPromptSubmit = [{ hooks: [wrapper] }];
    else delete settings.hooks.UserPromptSubmit;
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  }

  it('does not add back a hook the user removed after an earlier install, and names it', () => {
    installJsonHooks('claude-code');
    removePinnedInject();
    const before = readSettings();

    const again = installJsonHooks('claude-code');

    expect(again.installedUserPromptSubmit).toBe(false);
    expect(again.leftOut).toEqual([HIPPO_PINNED_INJECT_MARKER]);
    expect(readSettings()).toEqual(before);
    expect(readSettings().hooks.SessionEnd).toHaveLength(1);
    expect(readSettings().hooks.SessionStart).toHaveLength(3);
  });

  it('adds the removed hook back once the record is forgotten', () => {
    installJsonHooks('claude-code');
    removePinnedInject();
    expect(installJsonHooks('claude-code').leftOut).toEqual([HIPPO_PINNED_INJECT_MARKER]);

    forgetInstalledHooks('claude-code');
    const again = installJsonHooks('claude-code');

    expect(again.installedUserPromptSubmit).toBe(true);
    expect(again.leftOut).toEqual([]);
    expect(JSON.stringify(readSettings().hooks.UserPromptSubmit)).toContain(HIPPO_PINNED_INJECT_MARKER);
  });

  it('uninstall clears the record, so the next install adds every hook', () => {
    installJsonHooks('claude-code');
    expect(uninstallJsonHooks('claude-code')).toBe(true);

    const again = installJsonHooks('claude-code');

    expect(again.leftOut).toEqual([]);
    expect(again).toMatchObject({
      installedSessionEnd: true,
      installedSessionStart: true,
      installedSessionRules: true,
      installedUserPromptSubmit: true,
      installedPreCompact: true,
      installedCompactResume: true,
      installedPostCompact: true,
      installedCaptureError: true,
      installedNoteWritten: true,
    });
  });

  it('records every marker of a settings file that had all the hooks before the record existed, and writes no settings change', () => {
    installJsonHooks('claude-code');
    fs.rmSync(recordFile());
    const before = fs.readFileSync(settingsFile(), 'utf8');

    const again = installJsonHooks('claude-code');

    expect(again.leftOut).toEqual([]);
    expect(Object.values(again).filter((v) => v === true)).toEqual([]);
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before);
    const record = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    expect(record).toEqual({ [settingsFile()]: expect.arrayContaining(ALL_MARKERS) });
    expect(record[settingsFile()]).toHaveLength(ALL_MARKERS.length);
  });

  it('never removes or edits a wrapper hook the user put in place of the stock one, on install or uninstall', () => {
    const wrapper = { type: 'command', command: 'python', args: ['/x/my_hippo_wrapper.py'] };
    installJsonHooks('claude-code');
    removePinnedInject(wrapper);

    const again = installJsonHooks('claude-code');

    expect(again.leftOut).toEqual([HIPPO_PINNED_INJECT_MARKER]);
    expect(readSettings().hooks.UserPromptSubmit).toEqual([{ hooks: [wrapper] }]);
    uninstallJsonHooks('claude-code');
    expect(readSettings().hooks.UserPromptSubmit).toEqual([{ hooks: [wrapper] }]);
  });

  it('adds every hook to a settings file the user deleted', () => {
    installJsonHooks('claude-code');
    fs.rmSync(settingsFile());

    const again = installJsonHooks('claude-code');

    expect(again.leftOut).toEqual([]);
    expect(again.installedUserPromptSubmit).toBe(true);
    expect(JSON.stringify(readSettings().hooks)).toContain(HIPPO_NOTE_WRITTEN_MARKER);
  });

  it('reads a malformed record as empty and writes it again', () => {
    fs.mkdirSync(path.dirname(recordFile()), { recursive: true });
    fs.writeFileSync(recordFile(), '{ not json');

    const result = installJsonHooks('claude-code');

    expect(result.installedUserPromptSubmit).toBe(true);
    expect(JSON.parse(fs.readFileSync(recordFile(), 'utf8'))[settingsFile()]).toHaveLength(ALL_MARKERS.length);
  });

  it('still installs when the record cannot be saved', () => {
    fs.writeFileSync(path.join(tmpHome, '.hippo'), 'a file where the folder should be');

    const result = installJsonHooks('claude-code');

    expect(result.installedUserPromptSubmit).toBe(true);
    expect(readSettings().hooks.UserPromptSubmit).toHaveLength(1);
  });
});
