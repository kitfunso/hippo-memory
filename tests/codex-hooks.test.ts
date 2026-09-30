// Codex gets hippo's memory from two hooks in its own hooks.json; hippo appends them and never edits the user's entries.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_TRUST_LINE, installJsonHooks, uninstallJsonHooks } from '../src/hooks.js';
import { formatDoctor, runDoctor } from '../src/doctor.js';
import type { JsonValue } from '../src/working-memory.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';
import { initStore, saveSessionHandoff, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const START = '<!-- hippo:start -->';
const END = '<!-- hippo:end -->';
const EM_DASH = String.fromCodePoint(0x2014);

const PROMPT_GROUP = {
  hooks: [{
    type: 'command',
    command: 'hippo context --pinned-only --include-recent 5 --format additional-context',
    commandWindows: 'hippo.cmd context --pinned-only --include-recent 5 --format additional-context',
    timeout: 5,
  }],
};
const COMPACT_GROUP = {
  matcher: 'compact',
  hooks: [{ type: 'command', command: 'hippo compact-resume', commandWindows: 'hippo.cmd compact-resume', timeout: 10 }],
};
const HIPPO_ONLY = { hooks: { UserPromptSubmit: [PROMPT_GROUP], SessionStart: [COMPACT_GROUP] } };
const USER_GROUP = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo my own hook', timeout: 3 }] };

// The AGENTS.md block hippo 0.24.0 to 1.52.6 wrote for Codex, which init refreshes.
const OLD_CODEX = `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons ${EM_DASH} 2-5 bullets>'
\`\`\`
`.trim();

const readJson = (file: string): JsonValue => JSON.parse(fs.readFileSync(file, 'utf8'));
const snapshot = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('installJsonHooks(codex)', () => {
  const prevCodexHome = process.env.CODEX_HOME;
  let fake: FakeHomeHandle;
  let hooksFile: string;
  beforeEach(() => {
    fake = withFakeHome('hippo-codex-hooks-');
    process.env.CODEX_HOME = path.join(fake.home, 'codex-home');
    hooksFile = path.join(process.env.CODEX_HOME, 'hooks.json');
  });
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fake.cleanup();
  });

  it("writes only the per-prompt and compact-resume groups to an empty CODEX_HOME, each Claude Code's group plus a Windows command", () => {
    expect(installJsonHooks('codex')).toMatchObject({ settingsPath: hooksFile, installedUserPromptSubmit: true, installedCompactResume: true, invalidJson: false });
    expect(readJson(hooksFile)).toEqual(HIPPO_ONLY);
    const posixOnly = (group: typeof PROMPT_GROUP) => ({ ...group, hooks: group.hooks.map(({ commandWindows: _windows, ...hook }) => hook) });
    expect(readJson(installJsonHooks('claude-code').settingsPath)).toMatchObject({
      hooks: {
        UserPromptSubmit: expect.arrayContaining([posixOnly(PROMPT_GROUP)]),
        SessionStart: expect.arrayContaining([posixOnly(COMPACT_GROUP)]),
      },
    });
  });

  it('the reminder that install and doctor print says the per-prompt hook sends the five most recent memories too', () => {
    installJsonHooks('codex');
    expect(JSON.stringify(readJson(hooksFile))).toContain('hippo context --pinned-only --include-recent 5 ');
    expect(CODEX_TRUST_LINE).toContain('your pinned memories plus the five most recent ones');
  });

  it("keeps the user's description and hooks, and appends hippo's groups after them", () => {
    writeFile(hooksFile, JSON.stringify({ description: 'mine', hooks: { SessionStart: [USER_GROUP], Stop: [USER_GROUP] } }, null, 2));
    installJsonHooks('codex');
    expect(readJson(hooksFile)).toEqual({
      description: 'mine',
      hooks: { SessionStart: [USER_GROUP, COMPACT_GROUP], Stop: [USER_GROUP], UserPromptSubmit: [PROMPT_GROUP] },
    });
  });

  it('changes no byte on a second install, and never rewrites a file that already has both groups', () => {
    installJsonHooks('codex');
    const once = fs.readFileSync(hooksFile, 'utf8');
    expect(installJsonHooks('codex')).toMatchObject({ installedUserPromptSubmit: false, installedCompactResume: false });
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(once);
    const oneLine = JSON.stringify({ hooks: { SessionStart: [USER_GROUP, COMPACT_GROUP], UserPromptSubmit: [PROMPT_GROUP] } });
    fs.writeFileSync(hooksFile, oneLine);
    installJsonHooks('codex');
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(oneLine);
  });

  it("uninstall removes only hippo's two groups and keeps the user's hooks, even one that runs hippo", () => {
    const ownHippo = { hooks: [{ type: 'command', command: 'hippo last-sleep', timeout: 5 }] };
    const user = { hooks: { SessionStart: [USER_GROUP, ownHippo], Stop: [USER_GROUP] } };
    writeFile(hooksFile, JSON.stringify(user));
    installJsonHooks('codex');
    expect(uninstallJsonHooks('codex')).toBe(true);
    expect(readJson(hooksFile)).toEqual(user);
    expect(uninstallJsonHooks('codex')).toBe(false);
  });

  it("uninstall takes only hippo's exact handler: a group hippo shares keeps the other handler, and a user's hippo-like command stays", () => {
    const mine = { type: 'command', command: 'echo mine', timeout: 3 };
    const alike = { hooks: [{ type: 'command', command: 'hippo context --pinned-only --budget 300', timeout: 5 }, mine] };
    const shared = { matcher: 'compact', hooks: [mine, ...COMPACT_GROUP.hooks] };
    writeFile(hooksFile, JSON.stringify({ hooks: { UserPromptSubmit: [alike, PROMPT_GROUP], SessionStart: [shared] } }));
    expect(uninstallJsonHooks('codex')).toBe(true);
    expect(readJson(hooksFile)).toEqual({ hooks: { UserPromptSubmit: [alike], SessionStart: [{ matcher: 'compact', hooks: [mine] }] } });
  });

  it.each([
    ['unparseable JSON', '{ "hooks": '],
    ['null', 'null'],
    ['a top-level list', '[]'],
    ['hooks set to null', '{"hooks":null}'],
  ])('uninstall leaves a file holding %s untouched and reports nothing removed', (_label, text) => {
    writeFile(hooksFile, text);
    expect(uninstallJsonHooks('codex')).toBe(false);
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(text);
  });

  it('writes to $CODEX_HOME over ~/.codex, and to ~/.codex when CODEX_HOME is unset', () => {
    fs.mkdirSync(path.join(fake.home, '.codex'));
    installJsonHooks('codex');
    expect(fs.existsSync(hooksFile)).toBe(true);
    expect(fs.existsSync(path.join(fake.home, '.codex', 'hooks.json'))).toBe(false);
    delete process.env.CODEX_HOME;
    expect(installJsonHooks('codex').settingsPath).toBe(path.join(fake.home, '.codex', 'hooks.json'));
  });

  it('leaves a hippo command already in the file as it is, since Codex skips a changed hook until it is trusted again', () => {
    const older = { hooks: [{ type: 'command', command: 'hippo context --pinned-only --format additional-context', timeout: 5 }] };
    writeFile(hooksFile, JSON.stringify({ hooks: { UserPromptSubmit: [older] } }));
    expect(installJsonHooks('codex').migratedPinnedInjectRecent).toBe(false);
    expect(readJson(hooksFile)).toEqual({ hooks: { UserPromptSubmit: [older], SessionStart: [COMPACT_GROUP] } });
  });

  it.each([
    ['unparseable JSON', '{ "hooks": '],
    ['an event that is not a list', '{"hooks":{"SessionStart":{}}}'],
    ['a top-level list', '[]'],
  ])('leaves a file holding %s untouched and reports it', (_label, text) => {
    writeFile(hooksFile, text);
    expect(installJsonHooks('codex').invalidJson).toBe(true);
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(text);
  });
});

interface Machine { root: string; home: string; repo: string; codexDir: string }
const machines: string[] = [];
afterEach(() => {
  while (machines.length) fs.rmSync(machines.pop()!, { recursive: true, force: true });
});

function machine(): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-codex-cli-'));
  machines.push(root);
  const m = { root, home: path.join(root, 'home'), repo: path.join(root, 'repo'), codexDir: path.join(root, 'home', '.codex') };
  for (const dir of [m.home, m.repo, path.join(root, 'empty-path')]) fs.mkdirSync(dir, { recursive: true });
  return m;
}

// A PATH with no codex on it, because `hook install codex` and `setup` rename the launcher they find there.
function cliEnv(m: Machine, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(path|codex_home|hippo_skip_auto_integrations)$/i.test(key)) delete env[key];
  return Object.assign(env, {
    HOME: m.home,
    USERPROFILE: m.home,
    APPDATA: path.join(m.root, 'appdata'),
    LOCALAPPDATA: path.join(m.root, 'localappdata'),
    HIPPO_HOME: path.join(m.root, 'global'),
    PATH: path.join(m.root, 'empty-path'),
    ...extraEnv,
  });
}
function hippo(m: Machine, extraEnv: Record<string, string>, cwd: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd, env: cliEnv(m, extraEnv), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
// Without --no-schedule init would register a real OS task, without --no-learn it would run git.
const init = (m: Machine, extraEnv: Record<string, string> = {}) => hippo(m, extraEnv, m.repo, 'init', '--no-schedule', '--no-learn');
const SKIP = { HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
const agentsMd = (m: Machine) => path.join(m.repo, 'AGENTS.md');

describe('hippo init and Codex', () => {
  it('writes no Codex hook and creates no folder when neither CODEX_HOME nor ~/.codex exists', () => {
    const m = machine();
    fs.writeFileSync(agentsMd(m), '# Agents\n');
    const out = init(m);
    expect(out).toContain('Auto-installed codex hook in AGENTS.md');
    expect(fs.existsSync(m.codexDir)).toBe(false);
    expect(fs.readdirSync(m.root, { recursive: true }).map(String).filter((f) => path.basename(f) === 'hooks.json')).toEqual([]);
    expect(out).not.toContain(CODEX_TRUST_LINE);
  });

  it('adds both groups to $CODEX_HOME/hooks.json and prints the trust reminder', () => {
    const m = machine();
    fs.writeFileSync(agentsMd(m), '# Agents\n');
    const codexHome = path.join(m.root, 'codex-home');
    fs.mkdirSync(codexHome);
    const out = init(m, { CODEX_HOME: codexHome });
    expect(readJson(path.join(codexHome, 'hooks.json'))).toEqual(HIPPO_ONLY);
    expect(fs.existsSync(m.codexDir)).toBe(false);
    expect(out).toContain(CODEX_TRUST_LINE);
  });

  it('writes no Codex hook and creates no folder when CODEX_HOME names a folder that does not exist', () => {
    const m = machine();
    fs.writeFileSync(agentsMd(m), '# Agents\n');
    const codexHome = path.join(m.root, 'codex-home');
    const out = init(m, { CODEX_HOME: codexHome });
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(out).not.toContain(CODEX_TRUST_LINE);
  });

  const writes: Array<{ name: string; setup: (m: Machine) => void; watched: (m: Machine) => string }> = [
    { name: 'the AGENTS.md block', setup: (m) => fs.writeFileSync(agentsMd(m), '# Agents\n'), watched: agentsMd },
    {
      name: 'the refresh of an older AGENTS.md block',
      setup: (m) => fs.writeFileSync(agentsMd(m), `# Agents\n\n${START}\n\n${OLD_CODEX}\n  \n${END}\n`),
      watched: agentsMd,
    },
    {
      name: 'the Claude Code settings hooks',
      setup: (m) => fs.writeFileSync(path.join(m.repo, 'CLAUDE.md'), '# Rules\n'),
      watched: (m) => path.join(m.home, '.claude', 'settings.json'),
    },
    {
      name: 'the OpenCode plugin',
      setup: (m) => fs.writeFileSync(path.join(m.repo, 'opencode.json'), '{}\n'),
      watched: (m) => path.join(m.home, '.config', 'opencode', 'plugins', 'hippo.ts'),
    },
    {
      name: "Codex's hooks.json",
      setup: (m) => { fs.writeFileSync(agentsMd(m), '# Agents\n'); fs.mkdirSync(m.codexDir); },
      watched: (m) => path.join(m.codexDir, 'hooks.json'),
    },
  ];

  it.each(writes)('HIPPO_SKIP_AUTO_INTEGRATIONS=1 skips $name, which init writes without it', ({ setup, watched }) => {
    for (const skip of [true, false]) {
      const m = machine();
      setup(m);
      const before = snapshot(watched(m));
      const out = init(m, skip ? SKIP : {});
      if (skip) {
        expect(snapshot(watched(m))).toBe(before);
        expect(out).toContain('HIPPO_SKIP_AUTO_INTEGRATIONS=1, so init left agent instruction files and hooks alone.');
      } else {
        expect(snapshot(watched(m))).not.toBe(before);
      }
    }
  });

  it('init --scan with HIPPO_SKIP_AUTO_INTEGRATIONS=1 installs no user-level hook, and installs all three without it', () => {
    for (const skip of [true, false]) {
      const m = machine();
      fs.mkdirSync(path.join(m.repo, '.git'));
      for (const [file, text] of [['CLAUDE.md', '# Rules\n'], ['AGENTS.md', '# Agents\n'], ['opencode.json', '{}\n']]) {
        fs.writeFileSync(path.join(m.repo, file), text);
      }
      fs.mkdirSync(m.codexDir);
      hippo(m, skip ? SKIP : {}, m.root, 'init', '--scan', m.root, '--no-schedule', '--no-learn');
      const written = [
        path.join(m.home, '.claude', 'settings.json'),
        path.join(m.home, '.config', 'opencode', 'plugins', 'hippo.ts'),
        path.join(m.codexDir, 'hooks.json'),
      ].map((file) => fs.existsSync(file));
      expect(written).toEqual([!skip, !skip, !skip]);
    }
  });
});

describe('hippo hook install codex and hippo setup', () => {
  it('hook install codex adds both groups and the reminder with no codex launcher on PATH, and uninstall removes them', () => {
    const m = machine();
    const env = { CODEX_HOME: path.join(m.root, 'codex-home') };
    const hooksFile = path.join(env.CODEX_HOME, 'hooks.json');
    const out = hippo(m, env, m.repo, 'hook', 'install', 'codex');
    expect(readJson(hooksFile)).toEqual(HIPPO_ONLY);
    expect(out).toContain(CODEX_TRUST_LINE);
    expect(out).toContain('No codex launcher on PATH, so session-end capture was not set up');
    expect(hippo(m, env, m.repo, 'hook', 'uninstall', 'codex')).toContain("Removed hippo's Codex memory hooks");
    expect(readJson(hooksFile)).toEqual({});
  });

  it('setup adds both groups when ~/.codex exists, with the reminder', () => {
    const m = machine();
    fs.mkdirSync(m.codexDir);
    const out = hippo(m, {}, m.repo, 'setup', '--no-schedule');
    expect(readJson(path.join(m.codexDir, 'hooks.json'))).toEqual(HIPPO_ONLY);
    expect(out).toContain(CODEX_TRUST_LINE);
  });
});

// The fields Codex sends on stdin to SessionStart and UserPromptSubmit hooks, per codex-rs/hooks.
interface CodexPayload {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: 'SessionStart' | 'UserPromptSubmit';
  model: string;
  permission_mode: string;
  turn_id?: string;
  prompt?: string;
  source?: string;
}

function runCodexHook(m: Machine, command: string, payload: CodexPayload): string {
  const [bin, ...args] = command.split(' ');
  expect(bin).toBe('hippo');
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: payload.cwd, env: cliEnv(m, {}), input: JSON.stringify(payload), encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('the installed Codex hooks, run with the payloads Codex sends', () => {
  it('delivers a pinned global memory once from a projectless cwd', () => {
    const m = machine();
    const globalStore = path.join(m.root, 'global');
    initStore(globalStore);
    const entry = createMemory('projectless hook remembers the staging flag', { pinned: true });
    entry.origin_project = '';
    writeEntry(globalStore, entry);
    const foreignFolder = path.join(m.root, 'other-project');
    fs.mkdirSync(foreignFolder);
    saveSessionHandoff(globalStore, 'default', {
      version: 1,
      sessionId: 'other-project-session',
      repoRoot: foreignFolder,
      summary: 'Foreign project handoff summary',
      nextAction: 'Resume the unrelated deployment',
      artifacts: [],
    });
    const env = { CODEX_HOME: path.join(m.root, 'codex-home') };
    hippo(m, env, m.repo, 'hook', 'install', 'codex');
    expect(readJson(path.join(env.CODEX_HOME, 'hooks.json'))).toEqual(HIPPO_ONLY);
    const command = PROMPT_GROUP.hooks[0].command;
    const base = { session_id: 'projectless-codex', transcript_path: null, cwd: m.repo, model: 'gpt-5-codex', permission_mode: 'default', hook_event_name: 'UserPromptSubmit' as const, prompt: 'what flag?' };
    const first = runCodexHook(m, command, { ...base, turn_id: 't1' });
    const context = JSON.parse(first).hookSpecificOutput.additionalContext;
    expect(context).toContain('projectless hook remembers the staging flag');
    expect(context).toContain('[global]');
    expect(context).not.toContain('Foreign project handoff summary');
    expect(context).not.toContain('Resume the unrelated deployment');
    expect(runCodexHook(m, command, { ...base, turn_id: 't2' })).toBe('');
    fs.writeFileSync(path.join(globalStore, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));
    expect(runCodexHook(m, command, { ...base, session_id: 'projectless-disabled', turn_id: 't1' })).toBe('');
    expect(fs.existsSync(path.join(m.repo, '.hippo'))).toBe(false);
  });

  it('send the pinned block once, skip it while unchanged, and after a compaction restore the saved snapshot and send the block again', () => {
    const m = machine();
    hippo(m, {}, m.repo, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    hippo(m, {}, m.repo, 'remember', 'the release script needs the staging flag', '--pin');
    hippo(m, {}, m.repo, 'snapshot', 'save', '--task', 'Ship the release', '--summary', 'tests pass', '--next-step', 'tag it', '--session', 'codex-1');
    const env = { CODEX_HOME: path.join(m.root, 'codex-home') };
    hippo(m, env, m.repo, 'hook', 'install', 'codex');
    expect(readJson(path.join(env.CODEX_HOME, 'hooks.json'))).toEqual(HIPPO_ONLY);

    const base = { session_id: 'codex-1', transcript_path: null, cwd: m.repo, model: 'gpt-5-codex', permission_mode: 'default' };
    const prompt = (turn: string): string => runCodexHook(m, PROMPT_GROUP.hooks[0].command, { ...base, hook_event_name: 'UserPromptSubmit', turn_id: turn, prompt: 'what does the release need?' });
    const context = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

    expect(context(prompt('t1'))).toContain('the release script needs the staging flag');
    expect(prompt('t2')).toBe('');
    const resumed = runCodexHook(m, COMPACT_GROUP.hooks[0].command, { ...base, hook_event_name: 'SessionStart', source: 'compact' });
    expect(resumed).toContain('## Restored after compaction');
    expect(resumed).toContain('Ship the release');
    expect(context(prompt('t3'))).toContain('the release script needs the staging flag');
  });
});

describe('hippo doctor and Codex', () => {
  it('says nothing without Codex, warns with the fix before the hooks are in, and passes with the trust reminder after', () => {
    const fake = withFakeHome('hippo-codex-doctor-');
    try {
      const report = () => runDoctor({ cwd: fake.home, home: fake.home, version: 'test' });
      expect(report().checks.find((c) => c.id === 'codex')).toBeUndefined();
      fs.mkdirSync(path.join(fake.home, '.codex'));
      const before = report();
      expect(before.checks.find((c) => c.id === 'codex')).toMatchObject({ status: 'warn', detail: "Codex found, but hippo's memory hooks are not installed" });
      expect(formatDoctor(before)).toContain('fix: hippo hook install codex   (then trust the hooks once in /hooks)');
      installJsonHooks('codex');
      expect(formatDoctor(report())).toContain(`[ok  ] codex       Codex: hippo memory hooks installed. ${CODEX_TRUST_LINE}`);
    } finally {
      fake.cleanup();
    }
  });

  it.each([
    ['unparseable JSON', '{ "hooks": '],
    ['a top-level list', '[]'],
  ])('warns that Codex runs no hook from a hooks.json holding %s', (_label, text) => {
    const fake = withFakeHome('hippo-codex-doctor-');
    try {
      writeFile(path.join(fake.home, '.codex', 'hooks.json'), text);
      const report = runDoctor({ cwd: fake.home, home: fake.home, version: 'test' });
      expect(report.checks.find((c) => c.id === 'codex')).toMatchObject({ status: 'warn', detail: "Codex's hooks.json is not a JSON object, so Codex runs no hook from it" });
      expect(formatDoctor(report)).toContain('fix: repair hooks.json, then run: hippo hook install codex');
    } finally {
      fake.cleanup();
    }
  });
});
