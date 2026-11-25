import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import type { JsonValue } from '../../src/base/util/json.js';
import { detectInstalledTools } from '../../src/surface/hooks-install/detect.js';
import { hippoCommand } from '../../src/surface/hooks-install/rules/mcp-config.js';
import { HOME_TARGETS, homeTarget } from '../../src/surface/cli/home-targets.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';

interface Host {
  readonly name: string;
  readonly dir: readonly string[];
  readonly file: readonly string[];
  readonly key: string | null;
  readonly server: Readonly<Record<string, JsonValue>>;
}

const PLAIN_SERVER = { command: hippoCommand(), args: ['mcp'] };

const HOSTS: readonly Host[] = [
  { name: 'junie', dir: ['.junie'], file: ['.junie', 'mcp', 'mcp.json'], key: 'mcpServers', server: PLAIN_SERVER },
  {
    name: 'antigravity',
    dir: ['.gemini', 'antigravity'],
    file: ['.gemini', 'config', 'mcp_config.json'],
    key: 'mcpServers',
    server: PLAIN_SERVER,
  },
  { name: 'grok-build', dir: ['.grok'], file: ['.grok', 'config.toml'], key: null, server: PLAIN_SERVER },
  {
    name: 'muse-code',
    dir: ['.config', 'muse'],
    file: ['.config', 'muse', 'settings.json'],
    key: 'mcp_servers',
    server: { transport: 'stdio', command: hippoCommand(), args: ['mcp'], mode: 'optional' },
  },
];

const OUTPUT_FORMS: readonly Host[] = [HOSTS[0], HOSTS[2]];

const FLAGS = ['--no-schedule', '--no-learn'];
const INIT_FLAGS = [...FLAGS, '--no-embeddings'];
const ADDED = /^\s+(junie|antigravity|grok-build|muse-code)\s+Added the "hippo" MCP server -> (.+)$/gm;
const WOULD_ADD = /^\[dry-run\] would add the MCP server to (.+)$/gm;

interface Machine {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function machine(extraEnv: NodeJS.ProcessEnv = {}): Machine {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-hosts-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const emptyPath = path.join(root, 'empty-path');
  for (const dir of [home, project, emptyPath]) fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(path|codex_home|claude_config_dir|grok_home|hippo_skip_auto_integrations|xdg_config_home|vscode_portable)$/i.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    VSCODE_APPDATA: path.join(root, 'vscode-data'),
    HIPPO_HOME: path.join(root, 'global'),
    COPILOT_HOME: path.join(home, '.copilot'),
    HIPPO_SKIP_SCHEDULE: '1',
    HIPPO_SKIP_EMBEDDER_INSTALL: '1',
    PATH: emptyPath,
    ...extraEnv,
  });
  return { root, home, project, env };
}

const fileOf = (m: Machine, host: Host): string => path.join(m.home, ...host.file);
const dirOf = (m: Machine, host: Host): string => path.join(m.home, ...host.dir);
const presentDirs = (m: Machine, ...hosts: Host[]): void => {
  for (const host of hosts) fs.mkdirSync(dirOf(m, host), { recursive: true });
};

function hippo(m: Machine, ...args: string[]): SpawnSyncReturns<string> {
  const r = hippoRun(args, { cwd: m.project, env: m.env, timeout: 25_000 });
  expect(r.status, r.stderr).toBe(0);
  return r;
}

const readText = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): JsonValue => JSON.parse(readText(file));

function expectHippoIn(m: Machine, host: Host): void {
  const file = fileOf(m, host);
  if (host.key === null) {
    expect(readText(file)).toContain(`[mcp_servers.hippo]\ncommand = "${hippoCommand()}"\nargs = ["mcp"]`);
  } else {
    expect(readJson(file)).toMatchObject({ [host.key]: { hippo: host.server } });
  }
}

const writtenHosts = (m: Machine): string[] =>
  HOSTS.filter((host) => fs.existsSync(fileOf(m, host))).map((host) => fileOf(m, host));

const matches = (text: string, pattern: RegExp, group: number): string[] =>
  [...text.matchAll(pattern)].map((hit) => hit[group].trim()).sort();

describe('the home target table and the setup detection rows', () => {
  it('give every MCP config host a detection row and a home target, in the same order', () => {
    const detected = detectInstalledTools().filter((tool) => tool.kind === 'mcp-config');

    expect(detected.map((tool) => tool.name)).toEqual(HOSTS.map((host) => host.name));
    expect(HOME_TARGETS.map((target) => target.name)).toEqual(['copilot', ...HOSTS.map((host) => host.name)]);
    for (const host of HOSTS) expect(homeTarget(host.name)?.name).toBe(host.name);
    expect(homeTarget('cursor')).toBeUndefined();
  });
});

describe.each(HOSTS)('hippo hook with $name', (host) => {
  it('installs the server, lists the target and removes only that server', () => {
    const m = machine();
    const file = fileOf(m, host);

    const install = hippo(m, 'hook', 'install', host.name);
    expect(install.stdout).toContain(`Added the "hippo" MCP server -> ${file}`);
    expectHippoIn(m, host);

    const again = hippo(m, 'hook', 'install', host.name);
    expect(again.stdout).toContain(`The "hippo" MCP server is already in ${file}`);

    const list = hippo(m, 'hook', 'list');
    expect(list.stdout).toContain(`${host.name.padEnd(15)} -> ${file}`);

    const uninstall = hippo(m, 'hook', 'uninstall', host.name);
    expect(uninstall.stdout).toContain(`Removed the "hippo" MCP server from ${file}`);
    expect(readText(file)).not.toContain('hippo');

    const second = hippo(m, 'hook', 'uninstall', host.name);
    expect(second.stdout).toContain(`No hippo MCP server found in ${file}`);
  });
});

describe('hippo hook with GROK_HOME set', () => {
  it('writes and removes the Grok Build server under GROK_HOME and leaves ~/.grok alone', () => {
    const base = machine();
    const grokHome = path.join(base.root, 'grok-elsewhere');
    const m = { ...base, env: { ...base.env, GROK_HOME: grokHome } };
    const file = path.join(grokHome, 'config.toml');

    const install = hippo(m, 'hook', 'install', 'grok-build');
    expect(install.stdout).toContain(`Added the "hippo" MCP server -> ${file}`);
    expect(readText(file)).toContain(`[mcp_servers.hippo]\ncommand = "${hippoCommand()}"\nargs = ["mcp"]`);
    expect(fs.existsSync(path.join(m.home, '.grok'))).toBe(false);

    const uninstall = hippo(m, 'hook', 'uninstall', 'grok-build');
    expect(uninstall.stdout).toContain(`Removed the "hippo" MCP server from ${file}`);
  });
});

describe.each(OUTPUT_FORMS)('hippo hook output with $name', (host) => {
  it('prints the entry to paste for hook install and setup, a hint for init, and leaves a user-owned entry', () => {
    const m = machine();
    const file = fileOf(m, host);
    presentDirs(m, host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own =
      host.key === null
        ? '[mcp_servers.hippo]\ncommand = "node"\nargs = ["my-server.js"]\n'
        : JSON.stringify({ [host.key]: { hippo: { command: 'node', args: ['my-server.js'] } } });
    fs.writeFileSync(file, own);
    const left = `Left the "hippo" MCP server in ${file} as it is: hippo did not write it`;
    const paste = host.key === null ? '[mcp_servers.hippo]' : `under "${host.key}"`;

    const init = hippo(m, 'init', ...INIT_FLAGS);
    expect(init.stdout).toContain(`${left}; run \`hippo hook install ${host.name}\` to see the entry to paste\n`);
    expect(init.stdout).not.toContain(paste);

    const install = hippo(m, 'hook', 'install', host.name);
    expect(install.stdout).toContain(`${left}; replace the entry with this`);
    expect(install.stdout).toContain(paste);

    const setup = hippo(m, 'setup', ...FLAGS);
    expect(setup.stdout).toContain(`${left}; replace the entry with this`);
    expect(setup.stdout).toContain(paste);

    const uninstall = hippo(m, 'hook', 'uninstall', host.name);
    expect(uninstall.stdout).toContain(`Left the "hippo" MCP server in ${file}`);
    expect(readText(file)).toBe(own);
  });

  it('counts a hippo-memory entry that runs hippo mcp as set up by hand, and changes no byte', () => {
    const m = machine();
    const file = fileOf(m, host);
    presentDirs(m, host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own =
      host.key === null
        ? '[mcp_servers.hippo-memory]\ncommand = "hippo"\nargs = ["mcp"]\n'
        : JSON.stringify({ [host.key]: { 'hippo-memory': { command: 'hippo', args: ['mcp'] } } });
    fs.writeFileSync(file, own);

    const init = hippo(m, 'init', ...INIT_FLAGS);
    expect(init.stdout).toContain(`hippo's MCP server is already in ${file}, set up by hand; left as it is`);
    const install = hippo(m, 'hook', 'install', host.name);
    expect(install.stdout).toContain(`hippo's MCP server is already in ${file}, set up by hand; left as it is`);
    const uninstall = hippo(m, 'hook', 'uninstall', host.name);
    expect(uninstall.stdout).toContain(
      `Left hippo's MCP server in ${file}: it was set up by hand, so remove it by hand if you want it gone`,
    );
    expect(readText(file)).toBe(own);
  });

  it('leaves a file it cannot read unchanged and names the entry to add if there is no hippo server', () => {
    const m = machine();
    const file = fileOf(m, host);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = host.key === null ? 'note = """\nopen\n' : '// mine\n{}\n';
    fs.writeFileSync(file, broken);
    const reason =
      host.key === null ? 'is not a TOML file hippo can read' : 'has comments or is not a JSON object hippo can change';
    const add = host.key === null ? 'add this table by hand:' : `add this under "${host.key}" by hand: "hippo": `;

    const install = hippo(m, 'hook', 'install', host.name);
    expect(install.stdout).toContain(
      `WARNING: ${file} ${reason}, so it was left unchanged; if it has no hippo server, ${add}`,
    );
    expect(readText(file)).toBe(broken);
  });
});

describe('hippo hook install with a Muse Code file that has no schema_version', () => {
  it('says the file was left unchanged, why, and what to do', () => {
    const m = machine();
    const file = fileOf(m, HOSTS[3]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');

    const install = hippo(m, 'hook', 'install', 'muse-code');
    expect(install.stdout).toContain(
      `WARNING: ${file} was left unchanged: it has no "schema_version", which Muse Code needs; ` +
        'add "schema_version": 1. Then run `hippo hook install muse-code`\n',
    );
    expect(readText(file)).toBe('{}');
  });
});

describe('hippo hook with an unknown target', () => {
  it('names the four MCP hosts among the available targets', () => {
    const m = machine();
    const r = hippoRun(['hook', 'install', 'nothing-here'], { cwd: m.project, env: m.env, timeout: 25_000 });

    expect(r.status).not.toBe(0);
    for (const host of HOSTS) expect(r.stderr + r.stdout).toContain(host.name);
  });
});

describe('hippo setup with the MCP hosts', () => {
  it('writes the server for a host whose folder exists and skips the rest', () => {
    const m = machine();
    const [junie, ...others] = HOSTS;
    presentDirs(m, junie);

    const { stdout } = hippo(m, 'setup', ...FLAGS);

    expectHippoIn(m, junie);
    for (const host of others) {
      expect(stdout).toContain(`${host.name.padEnd(14)} not detected at ${dirOf(m, host)} -- skipping`);
      expect(fs.existsSync(fileOf(m, host))).toBe(false);
    }
    expect(matches(stdout, ADDED, 2)).toEqual([fileOf(m, junie)]);
  });

  it('writes every host with its folder present, and says so on a second run', () => {
    const m = machine();
    presentDirs(m, ...HOSTS);

    hippo(m, 'setup', ...FLAGS);
    for (const host of HOSTS) expectHippoIn(m, host);

    const second = hippo(m, 'setup', ...FLAGS);
    expect(second.stdout.match(/The "hippo" MCP server is already in/g)).toHaveLength(HOSTS.length);
  });

  it('does not say no tools were detected when only an MCP config host is present', () => {
    const m = machine();
    presentDirs(m, HOSTS[0]);

    const { stdout } = hippo(m, 'setup', ...FLAGS);

    expect(stdout).not.toContain('No JSON-hook-capable tools detected');
    expect(stdout).not.toContain('Run with --all to install hooks anyway.');
  });

  it('says no tools were detected when no host is present', () => {
    const m = machine();

    const { stdout } = hippo(m, 'setup', ...FLAGS);

    expect(stdout).toContain('No JSON-hook-capable tools detected');
    expect(stdout).toContain('Run with --all to install hooks anyway.');
  });

  it('still writes the other hosts when XDG_CONFIG_HOME is a file, and names the folder where the OS says ENOTDIR', () => {
    const base = machine();
    const xdg = path.join(base.root, 'xdg-file');
    fs.writeFileSync(xdg, 'not a folder');
    const m = { ...base, env: { ...base.env, XDG_CONFIG_HOME: xdg } };
    const museDir = path.join(xdg, 'muse');
    const osSaysEnotdir = (() => {
      try {
        fs.statSync(museDir, { throwIfNoEntry: false });
        return false;
      } catch (err) {
        return err instanceof Error && 'code' in err && err.code === 'ENOTDIR';
      }
    })();
    presentDirs(m, HOSTS[0]);

    const { stderr } = hippo(m, 'setup', ...FLAGS);

    expectHippoIn(m, HOSTS[0]);
    expect(fs.existsSync(path.join(xdg, 'muse'))).toBe(false);
    if (osSaysEnotdir) expect(stderr).toContain(museDir);
  });

  it('--all writes every host even with no folder present', () => {
    const m = machine();

    const { stdout } = hippo(m, 'setup', '--all', ...FLAGS);

    for (const host of HOSTS) expectHippoIn(m, host);
    expect(matches(stdout, ADDED, 2)).toEqual(HOSTS.map((host) => fileOf(m, host)).sort());
    expect(stdout).not.toContain('not detected at ' + dirOf(m, HOSTS[0]));
  });

  it.each([
    ['two hosts present', [0, 2], []],
    ['no host present', [], []],
    ['no host present, with --all', [], ['--all']],
    ['all hosts present', [0, 1, 2, 3], []],
  ] as const)('--dry-run names the files the real run writes: %s', (_label, present, extra) => {
    const m = machine();
    presentDirs(m, ...present.map((i) => HOSTS[i]));

    const dry = hippo(m, 'setup', '--dry-run', ...extra, ...FLAGS);
    expect(writtenHosts(m)).toEqual([]);
    const real = hippo(m, 'setup', ...extra, ...FLAGS);

    const written = writtenHosts(m).sort();
    expect(matches(dry.stdout, WOULD_ADD, 1)).toEqual(written);
    expect(matches(real.stdout, ADDED, 2)).toEqual(written);
    for (const host of HOSTS.filter((candidate) => !written.includes(fileOf(m, candidate)))) {
      const skipping = `${host.name.padEnd(14)} not detected at ${dirOf(m, host)} -- skipping`;
      expect(dry.stdout).toContain(skipping);
      expect(real.stdout).toContain(skipping);
    }
  });
});

describe('hippo init with the MCP hosts', () => {
  it('writes the server for the hosts whose folder exists', () => {
    const m = machine();
    const [junie, antigravity, grok, muse] = HOSTS;
    presentDirs(m, junie, grok);

    const { stdout } = hippo(m, 'init', ...INIT_FLAGS);

    expectHippoIn(m, junie);
    expectHippoIn(m, grok);
    expect(fs.existsSync(fileOf(m, antigravity))).toBe(false);
    expect(fs.existsSync(fileOf(m, muse))).toBe(false);
    expect(matches(stdout, /^\s+(?:Added the "hippo" MCP server) -> (.+)$/gm, 1)).toEqual(
      [fileOf(m, junie), fileOf(m, grok)].sort(),
    );
  });

  it('writes the Antigravity file when only the CLI folder exists, and the Muse Code file under XDG_CONFIG_HOME', () => {
    const m = machine();
    const xdg = path.join(m.root, 'xdg');
    const museDir = path.join(xdg, 'muse');
    const cli = path.join(m.home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(cli, { recursive: true });
    fs.mkdirSync(museDir, { recursive: true });
    const withXdg = { ...m, env: { ...m.env, XDG_CONFIG_HOME: xdg } };

    hippo(withXdg, 'init', ...INIT_FLAGS);

    expect(readJson(path.join(m.home, '.gemini', 'config', 'mcp_config.json'))).toMatchObject({
      mcpServers: { hippo: PLAIN_SERVER },
    });
    expect(readJson(path.join(museDir, 'settings.json'))).toMatchObject({
      schema_version: 1,
      mcp_servers: { hippo: HOSTS[3].server },
    });
    expect(fs.existsSync(path.join(m.home, '.config', 'muse', 'settings.json'))).toBe(false);
  });

  it('writes nothing with --no-hooks', () => {
    const m = machine();
    presentDirs(m, ...HOSTS);

    hippo(m, 'init', '--no-hooks', ...INIT_FLAGS);

    expect(writtenHosts(m)).toEqual([]);
  });

  it('writes nothing with HIPPO_SKIP_AUTO_INTEGRATIONS=1', () => {
    const m = machine({ HIPPO_SKIP_AUTO_INTEGRATIONS: '1' });
    presentDirs(m, ...HOSTS);

    hippo(m, 'init', ...INIT_FLAGS);

    expect(writtenHosts(m)).toEqual([]);
  });

  it('writes no Copilot file on a machine with only a VS Code User folder', () => {
    const m = machine();
    const userDir = path.join(m.root, 'vscode-data', 'Code', 'User');
    fs.mkdirSync(userDir, { recursive: true });

    hippo(m, 'init', ...INIT_FLAGS);

    expect(fs.existsSync(path.join(m.home, '.copilot'))).toBe(false);
    expect(fs.readdirSync(userDir)).toEqual([]);
    expect(writtenHosts(m)).toEqual([]);
  });
});
