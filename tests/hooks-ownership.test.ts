// Which Claude Code handlers hippo treats as its own, and which hooks values it refuses to merge into.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installJsonHooks, uninstallJsonHooks, resolveJsonHookPaths } from '../src/hooks/json-hooks.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';
import type { JsonValue } from '../src/json.js';

// The SessionEnd command hippo 0.20.3 wrote, with a `(` in front of `hippo sleep`.
const HIPPO_0_20_3 = "echo '[hippo] consolidating memory...' && (hippo sleep && echo '[hippo] sleep complete' || echo '[hippo] sleep failed')";
const LOOKALIKES = [
  'echo "hippo sleep done" >> ~/log',
  'notify-send "hippo session-end ran"',
  'say hippo sleep',
  'notify-send "Turn done (hippo sleep runs at exit)"',
  'echo "a; hippo sleep later"',
  './backup.sh && hippo sleep',
  'echo hi; hippo sleep',
];

let env: FakeHomeHandle;
beforeEach(() => {
  env = withFakeHome('hippo-ownership-');
});
afterEach(() => env.cleanup());

function seed(settings: JsonValue): string {
  const { settings: file } = resolveJsonHookPaths('claude-code');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings), 'utf8');
  return file;
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const group = (command: string) => ({ hooks: [{ type: 'command', command }] });

describe('a command hippo wrote itself', () => {
  it('init replaces the 0.20.3 SessionEnd command, so session-end is not added beside it', () => {
    const file = seed({ hooks: { SessionEnd: [group(HIPPO_0_20_3)] } });

    expect(installJsonHooks('claude-code').migratedSplitSessionEnd).toBe(true);

    const sessionEnd = read(file).hooks.SessionEnd;
    expect(sessionEnd).toHaveLength(1);
    expect(sessionEnd[0].hooks[0].command).toContain('hippo session-end --log-file');
  });

  it.each([
    HIPPO_0_20_3,
    'hippo sleep',
    'hippo sleep 2>/dev/null || true',
    'hippo sleep --log-file "C:\\Users\\me\\.hippo\\logs\\claude-code-sleep.log"',
    'hippo capture --last-session --log-file "x"',
    'hippo session-end --log-file "x"',
    'HIPPO_TENANT=work hippo session-end --log-file "x"',
    '/usr/local/bin/hippo sleep --log-file x',
    'C:\\npm\\hippo sleep',
  ])('uninstall removes %s', (command) => {
    const file = seed({ hooks: { SessionEnd: [group(command)] } });

    expect(uninstallJsonHooks('claude-code')).toBe(true);

    expect(read(file)).toEqual({});
  });
});

describe.each(['Stop', 'SessionEnd'])("a user's %s command that mentions hippo without running it", (event) => {
  it.each(LOOKALIKES)('survives install and uninstall: %s', (command) => {
    const file = seed({ hooks: { [event]: [group(command)] } });

    const result = installJsonHooks('claude-code');

    expect(result.migratedFromStop).toBe(false);
    expect(result.migratedSplitSessionEnd).toBe(false);
    expect(read(file).hooks[event][0]).toEqual(group(command));

    seed({ hooks: { [event]: [group(command)] } });
    expect(uninstallJsonHooks('claude-code')).toBe(false);
    expect(read(file)).toEqual({ hooks: { [event]: [group(command)] } });
  });
});

describe('a hooks value hippo cannot merge into', () => {
  it.each([
    ['a string', 'oops'],
    ['an array', []],
    ['null', null],
    ['an event that is not an array', { SessionEnd: 'echo mine' }],
  ])('%s: install reports invalidJson and writes nothing', (_label, hooks) => {
    const file = seed({ theme: 'dark', hooks });
    const before = fs.readFileSync(file, 'utf8');

    const result = installJsonHooks('claude-code');

    expect(result).toMatchObject({
      invalidJson: true,
      installedSessionEnd: false,
      installedSessionStart: false,
      installedUserPromptSubmit: false,
      installedPreCompact: false,
      installedCompactResume: false,
      installedPostCompact: false,
      installedCaptureError: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });
});

describe("a hippo handler the user gave a launcher or env prefix, which install must still see", () => {
  it.each([
    'HIPPO_TENANT=work hippo session-end --log-file "x"',
    'env X=1 hippo session-end --log-file "x"',
    'pnpm exec hippo session-end --log-file "x"',
    'nice hippo session-end --log-file "x"',
  ])('install adds no second session-end beside %s', (command) => {
    const file = seed({ hooks: { SessionEnd: [group(command)] } });

    const result = installJsonHooks('claude-code');

    expect(result.installedSessionEnd).toBe(false);
    expect(read(file).hooks.SessionEnd).toEqual([group(command)]);
  });

  it('uninstall keeps a launcher-prefixed handler and names it on stderr, while still removing the plain one', () => {
    const prefixed = ['nice hippo sleep', 'pnpm exec hippo session-end --log-file "x"'];
    const file = seed({ hooks: { SessionEnd: [group('hippo session-end --log-file "x"'), ...prefixed.map(group)] } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(uninstallJsonHooks('claude-code')).toBe(true);

      const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('remove any that are hippo'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(file);
      for (const command of prefixed) expect(lines[0]).toContain(JSON.stringify(command));
    } finally {
      stderr.mockRestore();
    }
    expect(read(file).hooks.SessionEnd).toEqual(prefixed.map(group));
  });

  it('uninstall says nothing when every handler it kept has no hippo command in it', () => {
    seed({ hooks: { SessionEnd: [group('node ~/hooks/redact.js')] } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(uninstallJsonHooks('claude-code')).toBe(false);

      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
