// hippo setup gives Copilot one hooks file hippo owns, one key in the shared mcp-config.json and an instructions block; uninstall takes back only those.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copilotHomeDir, detectInstalledTools } from '../src/hooks/shared.js';
import { COPILOT_INSTRUCTIONS, copilotMcpSnippet, copilotPaths, installCopilot, mergeMcpServer, uninstallCopilot } from '../src/hooks/copilot.js';
import { HOOKS } from '../src/cli/hook-blocks.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';
import type { JsonValue } from '../src/json.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const START = '<!-- hippo:start -->';
const END = '<!-- hippo:end -->';
const BOM = String.fromCodePoint(0xfeff);
const HIPPO_SERVER = { type: 'local', command: process.platform === 'win32' ? 'hippo.cmd' : 'hippo', args: ['mcp'], env: {}, tools: ['*'] };
const USER_SERVER = { type: 'local', command: 'npx', args: ['@playwright/mcp@latest'], tools: ['*'] };

interface HookEntry {
  readonly type: string;
  readonly bash: string;
  readonly powershell: string;
  readonly timeoutSec: number;
}
interface HooksFile {
  readonly version: number;
  readonly hooks: Readonly<Record<string, readonly HookEntry[]>>;
}
interface CopilotFiles {
  readonly hooks: string;
  readonly mcp: string;
  readonly instructions: string;
}

const entry = (args: string, timeoutSec: number): HookEntry[] => [{ type: 'command', bash: `hippo ${args}`, powershell: `hippo.cmd ${args}`, timeoutSec }];

/** The command contract the runtime side implements; no command names a path. */
const CONTRACT_HOOKS: HooksFile = {
  version: 1,
  hooks: {
    sessionStart: entry('context --pinned-only --include-recent 5 --format copilot', 10),
    postToolUseFailure: entry('capture-error --runtime copilot', 10),
    preCompact: entry('pre-compact --runtime copilot', 30),
    sessionEnd: entry('session-end --runtime copilot', 30),
  },
};

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): JsonValue => JSON.parse(read(file));
const readHooks = (file: string): HooksFile => JSON.parse(read(file));
function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const copilotBlock = (eol = '\n'): string => `${START}${eol}${COPILOT_INSTRUCTIONS.replace(/\n/g, eol)}${eol}${END}`;

describe('installCopilot and uninstallCopilot', () => {
  const prev = { copilot: process.env.COPILOT_HOME, hippo: process.env.HIPPO_HOME };
  let fake: FakeHomeHandle;
  let copilotHome: string;
  let files: CopilotFiles;
  beforeEach(() => {
    fake = withFakeHome('hippo-copilot-');
    copilotHome = path.join(fake.home, 'copilot-home');
    process.env.COPILOT_HOME = copilotHome;
    process.env.HIPPO_HOME = path.join(fake.home, 'hippo-global');
    files = { hooks: path.join(copilotHome, 'hooks', 'hippo.json'), mcp: path.join(copilotHome, 'mcp-config.json'), instructions: path.join(copilotHome, 'copilot-instructions.md') };
  });
  afterEach(() => {
    process.env.COPILOT_HOME = prev.copilot ?? '';
    process.env.HIPPO_HOME = prev.hippo ?? '';
    fake.cleanup();
  });

  it('writes the contract hooks file, the hippo MCP server and the instructions block into an empty COPILOT_HOME', () => {
    expect(installCopilot()).toMatchObject({ hooks: true, mcp: 'added', instructions: 'written' });
    expect(readHooks(files.hooks)).toEqual(CONTRACT_HOOKS);
    expect(readJson(files.mcp)).toEqual({ mcpServers: { hippo: HIPPO_SERVER } });
    expect(read(files.instructions)).toBe(`${copilotBlock()}\n`);
    expect(COPILOT_INSTRUCTIONS).toContain('`hippo_recall`');
    expect(COPILOT_INSTRUCTIONS).toContain('`hippo_remember`');
  });

  it('changes no byte in any of the three files on a second install', () => {
    installCopilot();
    const once = Object.values(files).map(read);
    expect(installCopilot()).toMatchObject({ hooks: false, mcp: 'present', instructions: 'present' });
    expect(Object.values(files).map(read)).toEqual(once);
  });

  it.each([
    ['a partial table', '{"version":1,"hooks":{"sessionStart":[]}}'],
    ['the earlier table whose sessionEnd named a quoted log path', JSON.stringify({ version: 1, hooks: { ...CONTRACT_HOOKS.hooks, sessionEnd: entry("session-end --runtime copilot --log-file '/home/you/.hippo/logs/copilot-sleep.log'", 30) } })],
  ])("rewrites hippo's own hooks file when it holds %s", (_label, text) => {
    writeFile(files.hooks, text);
    expect(installCopilot().hooks).toBe(true);
    expect(readHooks(files.hooks)).toEqual(CONTRACT_HOOKS);
  });

  it('no hook command names a path, so neither shell has anything to quote', () => {
    installCopilot();
    const commands = Object.values(readHooks(files.hooks).hooks).flatMap((hooks) => hooks.flatMap((h) => [h.bash, h.powershell]));
    expect(commands).toHaveLength(8);
    for (const command of commands) {
      expect(command).not.toMatch(/['"\\/]|--log-file/);
      expect(command).not.toContain(fake.home);
    }
  });

  it("keeps the user's other MCP servers and top-level keys", () => {
    writeFile(files.mcp, JSON.stringify({ theme: 'dark', mcpServers: { playwright: USER_SERVER } }));
    expect(installCopilot().mcp).toBe('added');
    expect(readJson(files.mcp)).toEqual({ theme: 'dark', mcpServers: { playwright: USER_SERVER, hippo: HIPPO_SERVER } });
  });

  it('reads an mcp-config.json saved with a byte order mark and writes it back without one', () => {
    writeFile(files.mcp, BOM + JSON.stringify({ mcpServers: { playwright: USER_SERVER } }));
    expect(installCopilot().mcp).toBe('added');
    expect(read(files.mcp).startsWith(BOM)).toBe(false);
    expect(readJson(files.mcp)).toEqual({ mcpServers: { playwright: USER_SERVER, hippo: HIPPO_SERVER } });
  });

  it.each([
    ['comments', '{\n  // my servers\n  "mcpServers": {}\n}\n'],
    ['invalid JSON', '{ "mcpServers": '],
    ['a top-level list', '[]'],
    ['mcpServers that is not an object', '{"mcpServers":[]}'],
  ])('refuses an mcp-config.json holding %s, leaves it untouched and still installs the rest', (_label, text) => {
    writeFile(files.mcp, text);
    expect(installCopilot()).toMatchObject({ hooks: true, mcp: 'unreadable', instructions: 'written' });
    expect(read(files.mcp)).toBe(text);
    expect(uninstallCopilot()).toMatchObject({ hooks: true, mcp: 'unreadable', instructions: 'removed' });
    expect(read(files.mcp)).toBe(text);
    expect(JSON.parse(`{${copilotMcpSnippet()}}`)).toEqual({ hippo: HIPPO_SERVER });
  });

  it('reports a filesystem error on mcp-config.json with its own message, not as unreadable JSON, and still installs the rest', () => {
    fs.mkdirSync(files.mcp, { recursive: true });
    const failed = { failed: expect.stringContaining('EISDIR') };
    expect(installCopilot()).toMatchObject({ hooks: true, mcp: failed, instructions: 'written' });
    expect(uninstallCopilot()).toMatchObject({ hooks: true, mcp: failed, instructions: 'removed' });
    expect(fs.statSync(files.mcp).isDirectory()).toBe(true);
  });

  it.each([
    ['another command', { command: 'node', args: ['C:/forks/hippo/mcp.js'], tools: ['*'] }],
    ['other args', { command: 'hippo', args: ['mcp', '--global'], tools: ['*'] }],
  ])('never overwrites or removes a "hippo" MCP key with %s, which hippo did not write', (_label, server) => {
    const text = JSON.stringify({ mcpServers: { hippo: server } });
    writeFile(files.mcp, text);
    expect(mergeMcpServer(files.mcp)).toBe('user-owned');
    expect(installCopilot().mcp).toBe('user-owned');
    expect(uninstallCopilot().mcp).toBe('user-owned');
    expect(read(files.mcp)).toBe(text);
  });

  it("uninstall removes only hippo's hooks file, its MCP key and its block, and a second uninstall finds nothing", () => {
    const userHooks = path.join(copilotHome, 'hooks', 'mine.json');
    const userHooksText = JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'echo hi', powershell: 'echo hi', timeoutSec: 5 }] } });
    writeFile(userHooks, userHooksText);
    writeFile(files.mcp, JSON.stringify({ mcpServers: { playwright: USER_SERVER } }));
    writeFile(files.instructions, '# My rules\n\nUse tabs.\n');
    installCopilot();

    expect(uninstallCopilot()).toMatchObject({ hooks: true, mcp: 'removed', instructions: 'removed' });
    expect(fs.existsSync(files.hooks)).toBe(false);
    expect(read(userHooks)).toBe(userHooksText);
    expect(readJson(files.mcp)).toEqual({ mcpServers: { playwright: USER_SERVER } });
    // The blank line install put before the block stays: uninstall takes the block and one line break, and no other byte.
    expect(read(files.instructions)).toBe('# My rules\n\nUse tabs.\n\n');
    expect(uninstallCopilot()).toMatchObject({ hooks: false, mcp: 'absent', instructions: 'absent' });
  });

  it('uninstall deletes an instructions file that held only the block, and drops an emptied mcpServers', () => {
    installCopilot();
    uninstallCopilot();
    expect(fs.existsSync(files.instructions)).toBe(false);
    expect(readJson(files.mcp)).toEqual({});
  });

  it('uninstall deletes an instructions file left with only whitespace around the block', () => {
    writeFile(files.instructions, `\n \r\n${copilotBlock()}\n\t\n`);
    expect(uninstallCopilot().instructions).toBe('removed');
    expect(fs.existsSync(files.instructions)).toBe(false);
  });

  it("replaces hippo's own Copilot block in the file's own CRLF endings, and changes no byte outside the markers", () => {
    const loose = `${START}\r\n\r\n${COPILOT_INSTRUCTIONS.replace(/\n/g, '\r\n')}\r\n\r\n\r\n${END}`;
    writeFile(files.instructions, `# My rules\r\n\r\n${loose}\r\nAfter.\r\n`);
    expect(installCopilot().instructions).toBe('written');
    expect(read(files.instructions)).toBe(`# My rules\r\n\r\n${copilotBlock('\r\n')}\r\nAfter.\r\n`);
  });

  it("appends the block after the user's text when the file has none", () => {
    writeFile(files.instructions, '# Mine');
    installCopilot();
    expect(read(files.instructions)).toBe(`# Mine\n\n${copilotBlock()}\n`);
  });

  it.each([
    ['an edited block', `# Mine\r\n\r\n${START}\r\nmy own hippo notes\r\n${END}\r\nAfter.\r\n`],
    ["another agent's block in a shared file", `# Shared\n\n${START}\n${HOOKS['claude-code'].content}\n${END}\n`],
  ])('install and uninstall keep %s byte for byte and add no second block', (_label, text) => {
    writeFile(files.instructions, text);
    expect(installCopilot().instructions).toBe('kept');
    expect(read(files.instructions)).toBe(text);
    expect(uninstallCopilot().instructions).toBe('kept');
    expect(read(files.instructions)).toBe(text);
  });

  it('a start marker with no end marker changes nothing on install or uninstall', () => {
    const text = `# Mine\n\n${START}\nhalf a block\n`;
    writeFile(files.instructions, text);
    expect(installCopilot().instructions).toBe('unclosed');
    expect(read(files.instructions)).toBe(text);
    expect(uninstallCopilot().instructions).toBe('unclosed');
    expect(read(files.instructions)).toBe(text);
  });

  it.each([
    ['CRLF text either side, extra blank lines kept', `# Mine\r\n\r\n\r\n${copilotBlock('\r\n')}\r\n\r\nAfter.  \r\n\r\n`, '# Mine\r\n\r\n\r\n\r\nAfter.  \r\n\r\n'],
    ['a block at the end with no line break after it', `Top\n${copilotBlock()}`, 'Top'],
    ['a block first in the file', `${copilotBlock()}\nBelow.`, 'Below.'],
  ])('uninstall splices out only the block and one line break: %s', (_label, text, left) => {
    writeFile(files.instructions, text);
    expect(uninstallCopilot().instructions).toBe('removed');
    expect(read(files.instructions)).toBe(left);
  });

  it('the Copilot folder is $COPILOT_HOME when set, else .copilot under os.homedir() whatever HOME says', () => {
    expect(copilotPaths().hooks).toBe(files.hooks);
    expect(copilotHomeDir(undefined, { COPILOT_HOME: copilotHome })).toBe(copilotHome);
    process.env.COPILOT_HOME = '';
    process.env.HOME = path.join(fake.home, 'corporate-home');
    expect(copilotHomeDir()).toBe(path.join(os.homedir(), '.copilot'));
    expect(copilotPaths().hooks).toBe(path.join(os.homedir(), '.copilot', 'hooks', 'hippo.json'));
  });

  it('detects Copilot only when its config folder exists, as a json-hook tool', () => {
    const copilot = () => detectInstalledTools().find((t) => t.name === 'copilot');
    expect(copilot()).toMatchObject({ kind: 'json-hook', detected: false, configDir: copilotHome });
    writeFile(copilotHome, 'not a folder');
    expect(copilot()?.detected).toBe(false);
    fs.rmSync(copilotHome);
    fs.mkdirSync(copilotHome);
    expect(copilot()?.detected).toBe(true);
    process.env.COPILOT_HOME = '';
    expect(copilot()).toMatchObject({ detected: false, configDir: path.join(fake.home, '.copilot') });
    fs.mkdirSync(path.join(fake.home, '.copilot'));
    expect(copilot()?.detected).toBe(true);
  });
});

interface Machine { root: string; home: string; copilot: string }
const machines: string[] = [];
afterEach(() => {
  while (machines.length) fs.rmSync(machines.pop()!, { recursive: true, force: true });
});

function machine(): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-copilot-cli-'));
  machines.push(root);
  const m = { root, home: path.join(root, "o'brien x"), copilot: path.join(root, 'copilot-home') };
  for (const dir of [m.home, path.join(root, 'empty-path')]) fs.mkdirSync(dir, { recursive: true });
  return m;
}

// A PATH with no codex on it, because setup renames a codex launcher it finds there.
function hippo(m: Machine, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(path|codex_home|claude_config_dir|hippo_skip_auto_integrations)$/i.test(key)) delete env[key];
  Object.assign(env, {
    HOME: m.home,
    USERPROFILE: m.home,
    APPDATA: path.join(m.root, 'appdata'),
    LOCALAPPDATA: path.join(m.root, 'localappdata'),
    HIPPO_HOME: path.join(m.root, 'global'),
    COPILOT_HOME: m.copilot,
    PATH: path.join(m.root, 'empty-path'),
  });
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: m.root, env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('hippo setup and hippo hook with Copilot', () => {
  it('setup skips Copilot and creates nothing when its folder is missing, and installs all three files once it exists', () => {
    const m = machine();
    expect(hippo(m, 'setup', '--no-schedule', '--no-learn')).toContain(`copilot        not detected at ${m.copilot} -- skipping`);
    expect(fs.existsSync(m.copilot)).toBe(false);

    fs.mkdirSync(m.copilot);
    const out = hippo(m, 'setup', '--no-schedule', '--no-learn');
    expect(out).toContain("Installed hippo's Copilot hooks (sessionStart, postToolUseFailure, preCompact, sessionEnd)");
    expect(out).toContain('VS Code Copilot runs new hooks in a new chat session.');
    expect(readHooks(path.join(m.copilot, 'hooks', 'hippo.json'))).toEqual(CONTRACT_HOOKS);
    expect(readJson(path.join(m.copilot, 'mcp-config.json'))).toEqual({ mcpServers: { hippo: HIPPO_SERVER } });
    expect(read(path.join(m.copilot, 'copilot-instructions.md'))).toContain(START);
    expect(hippo(m, 'setup', '--no-schedule', '--no-learn')).toContain("hippo's Copilot hooks are already in");
  });

  it('setup --dry-run names the three files and writes none', () => {
    const m = machine();
    fs.mkdirSync(m.copilot);
    expect(hippo(m, 'setup', '--dry-run', '--no-schedule', '--no-learn')).toContain(`[dry-run] would install hooks in ${path.join(m.copilot, 'hooks', 'hippo.json')}`);
    expect(fs.readdirSync(m.copilot)).toEqual([]);
  });

  it('setup prints the snippet to add by hand when mcp-config.json has comments, and leaves it as it was', () => {
    const m = machine();
    const text = '{\n  // mine\n  "mcpServers": {}\n}\n';
    writeFile(path.join(m.copilot, 'mcp-config.json'), text);
    const out = hippo(m, 'setup', '--no-schedule', '--no-learn');
    expect(out).toContain(`add this under "mcpServers" by hand: ${copilotMcpSnippet()}`);
    expect(read(path.join(m.copilot, 'mcp-config.json'))).toBe(text);
  });

  it('hook install and uninstall copilot round-trip, and hook list names it', () => {
    const m = machine();
    expect(hippo(m, 'hook', 'list')).toContain('copilot');
    hippo(m, 'hook', 'install', 'copilot');
    expect(fs.existsSync(path.join(m.copilot, 'hooks', 'hippo.json'))).toBe(true);
    const out = hippo(m, 'hook', 'uninstall', 'copilot');
    expect(out).toContain("Removed hippo's Copilot hooks file");
    expect(out).toContain('Removed the "hippo" MCP server');
    expect(fs.existsSync(path.join(m.copilot, 'hooks', 'hippo.json'))).toBe(false);
    expect(hippo(m, 'hook', 'uninstall', 'copilot')).toContain('No hippo Copilot hooks, MCP server or instructions block found.');
  });

  it.each([
    ['an edited block', `${START}\nmy own hippo notes\n${END}\n`, 'Kept the hippo block in'],
    ['a start marker with no end', `${START}\nhalf a block\n`, `has ${START} with no ${END}, so hippo left it unchanged`],
  ])('setup leaves copilot-instructions.md holding %s as it was and says so in one line', (_label, text, line) => {
    const m = machine();
    const file = path.join(m.copilot, 'copilot-instructions.md');
    writeFile(file, text);
    const out = hippo(m, 'setup', '--no-schedule', '--no-learn');
    expect(out.split('\n').filter((l) => l.includes(line))).toHaveLength(1);
    expect(read(file)).toBe(text);
  });

  it('setup reports a filesystem error on mcp-config.json with its own message and goes on to finish', () => {
    const m = machine();
    fs.mkdirSync(path.join(m.copilot, 'mcp-config.json'), { recursive: true });
    const out = hippo(m, 'setup', '--no-schedule', '--no-learn');
    expect(out).toMatch(/WARNING: hippo could not use .*mcp-config\.json \(EISDIR/);
    expect(out).toContain('Wrote the hippo block ->');
    expect(out).toContain('Done. Restart your AI tool');
  });
});
