import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Homes } from '../../src/base/util/agent-homes.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { hermesInstallLines, hermesRemoveLines, hermesTurnOnCommand } from '../../src/surface/cli/hermes-report.js';
import { detectInstalledTools } from '../../src/surface/hooks-install/detect.js';
import {
  hermesPluginPaths,
  installHermes,
  isHermesFailure,
  isHermesPresent,
  uninstallHermes,
} from '../../src/surface/hooks-install/hermes.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_DIR = path.join(REPO, 'extensions', 'hermes-memory-provider', 'hippo');
const BIN_SCRIPT = path.join(REPO, 'bin', 'hippo.js');
const PLUGIN_FILES = ['__init__.py', 'plugin.yaml', 'README.md'] as const;

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hermes-'));
  roots.push(root);
  return root;
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJson(file: string): JsonValue {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nativeHermesDir(home: string, localAppData: string, suffix = ''): string {
  return process.platform === 'win32'
    ? path.join(localAppData, `hermes${suffix}`)
    : path.join(home, `.hermes${suffix}`);
}

interface FakeMachine {
  readonly root: string;
  readonly home: string;
  readonly localAppData: string;
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
}

function makeMachine(extraEnv: NodeJS.ProcessEnv = {}): FakeMachine {
  const root = makeRoot();
  const home = path.join(root, 'home');
  const localAppData = path.join(root, 'localappdata');
  const project = path.join(root, 'project');
  const emptyPath = path.join(root, 'empty-path');
  for (const dir of [home, localAppData, project, emptyPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(path|codex_home|claude_config_dir|grok_home|hermes_home|hermes_data_dir_suffix|hippo_skip_auto_integrations|xdg_config_home|vscode_portable)$/i.test(
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
    LOCALAPPDATA: localAppData,
    VSCODE_APPDATA: path.join(root, 'vscode-data'),
    HIPPO_HOME: path.join(root, 'global'),
    COPILOT_HOME: path.join(home, '.copilot'),
    HIPPO_SKIP_SCHEDULE: '1',
    HIPPO_SKIP_EMBEDDER_INSTALL: '1',
    PATH: emptyPath,
    ...extraEnv,
  });
  return { root, home, localAppData, project, env };
}

async function hippo(m: FakeMachine, ...args: string[]): Promise<string> {
  const result = await runCliAs(args, { cwd: m.project, env: m.env });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('installHermes and uninstallHermes', () => {
  it('installs all plugin files and launcher.json into the default Hermes home without touching config.yaml', () => {
    const root = makeRoot();
    const home = path.join(root, 'user');
    const localAppData = path.join(root, 'local');
    const hermesHome = nativeHermesDir(home, localAppData);
    fs.mkdirSync(hermesHome, { recursive: true });
    const homes: Homes = { home, env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData } };

    expect(isHermesPresent(homes)).toBe(true);
    const result = installHermes(homes);
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');

    expect(result).toEqual({ status: 'installed', home: hermesHome, profile: null, pluginDir });
    const expectedHashes: Record<string, string> = {};
    for (const file of PLUGIN_FILES) {
      const source = fs.readFileSync(path.join(SOURCE_DIR, file));
      const installed = fs.readFileSync(path.join(pluginDir, file));
      expect(installed.equals(source)).toBe(true);
      expectedHashes[file] = sha256(source);
    }
    expect(readJson(path.join(pluginDir, 'launcher.json'))).toEqual({
      managedBy: 'hippo-memory',
      node: process.execPath,
      script: BIN_SCRIPT,
      hashes: expectedHashes,
    });
    expect(fs.existsSync(path.join(hermesHome, 'config.yaml'))).toBe(false);
    expect(hermesInstallLines(result)).toEqual([
      `Copied the hippo memory provider -> ${pluginDir}`,
      'Turn it on: hermes config set memory.provider hippo',
    ]);
  });

  it('installs into a named active_profile and prints the -p turn-on command', () => {
    const root = makeRoot();
    const hermesRoot = path.join(root, 'hermes-root');
    const workProfile = path.join(hermesRoot, 'profiles', 'work');
    fs.mkdirSync(workProfile, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, 'active_profile'), 'work\n');
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesRoot } };

    const paths = hermesPluginPaths(homes);
    expect(paths).toEqual({
      home: workProfile,
      profile: 'work',
      pluginDir: path.join(workProfile, 'plugins', 'hippo'),
    });

    const result = installHermes(homes);
    expect(result.status).toBe('installed');
    expect(result.profile).toBe('work');
    expect(hermesTurnOnCommand(result.profile)).toBe('hermes -p work config set memory.provider hippo');
    expect(hermesInstallLines(result)).toEqual([
      `Copied the hippo memory provider -> ${paths.pluginDir}`,
      'Turn it on: hermes -p work config set memory.provider hippo',
    ]);
  });

  it('is idempotent on a second install with no writes and refreshes when stale', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const first = installHermes(homes);
    expect(first.status).toBe('installed');

    const past = new Date('2020-01-01T00:00:00Z');
    const managed = [...PLUGIN_FILES, 'launcher.json'].map((name) => path.join(first.pluginDir, name));
    for (const file of managed) fs.utimesSync(file, past, past);
    const beforeMtimes = managed.map((file) => fs.statSync(file).mtimeMs);

    const second = installHermes(homes);
    expect(second.status).toBe('present');
    expect(managed.map((file) => fs.statSync(file).mtimeMs)).toEqual(beforeMtimes);
    expect(hermesInstallLines(second)).toEqual([
      `The hippo memory provider is already in ${first.pluginDir}`,
      'Turn it on: hermes config set memory.provider hippo',
    ]);

    const oldInit = Buffer.from('# old hippo release\n');
    const launcherPath = path.join(first.pluginDir, 'launcher.json');
    const currentLauncher = JSON.parse(fs.readFileSync(launcherPath, 'utf8'));
    currentLauncher.hashes['__init__.py'] = sha256(oldInit);
    fs.writeFileSync(path.join(first.pluginDir, '__init__.py'), oldInit);
    fs.writeFileSync(launcherPath, JSON.stringify(currentLauncher, null, 2));

    const refreshed = installHermes(homes);
    expect(refreshed.status).toBe('updated');
    expect(
      fs
        .readFileSync(path.join(first.pluginDir, '__init__.py'))
        .equals(fs.readFileSync(path.join(SOURCE_DIR, '__init__.py'))),
    ).toBe(true);

    const staleLauncher = JSON.parse(fs.readFileSync(launcherPath, 'utf8'));
    staleLauncher.node = '/old/node';
    fs.writeFileSync(launcherPath, JSON.stringify(staleLauncher, null, 2));

    const refreshedLauncher = installHermes(homes);
    expect(refreshedLauncher.status).toBe('updated');
    expect(readJson(launcherPath)).toMatchObject({ node: process.execPath, script: BIN_SCRIPT });
  });

  it.each([
    ['missing launcher.json', null],
    ['invalid launcher.json', '{not json'],
    ['wrong managedBy', JSON.stringify({ managedBy: 'someone-else', node: 'node', script: 'x' })],
  ])('refuses a user-owned pluginDir with %s on install and uninstall', (_label, launcherText) => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    fs.mkdirSync(pluginDir, { recursive: true });
    const customInit = 'custom_provider = True\n';
    fs.writeFileSync(path.join(pluginDir, '__init__.py'), customInit);
    if (launcherText !== null) {
      fs.writeFileSync(path.join(pluginDir, 'launcher.json'), launcherText);
    }
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const installed = installHermes(homes);
    expect(installed.status).toBe('user-owned');
    expect(hermesInstallLines(installed)).toEqual([
      `Left ${pluginDir} as it is: it was not written by hippo or was edited by hand`,
    ]);

    const removed = uninstallHermes(homes);
    expect(removed.status).toBe('user-owned');
    expect(hermesRemoveLines(removed)).toEqual([
      `Left ${pluginDir} as it is: it was not written by hippo or was edited by hand`,
    ]);
    expect(fs.readFileSync(path.join(pluginDir, '__init__.py'), 'utf8')).toBe(customInit);
  });

  it('refuses a hand-edited managed file on install and uninstall', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const first = installHermes(homes);
    expect(first.status).toBe('installed');
    const edited = `${fs.readFileSync(path.join(first.pluginDir, '__init__.py'), 'utf8')}\n# hand edit\n`;
    fs.writeFileSync(path.join(first.pluginDir, '__init__.py'), edited);

    expect(installHermes(homes).status).toBe('kept');
    expect(uninstallHermes(homes).status).toBe('kept');
    expect(fs.readFileSync(path.join(first.pluginDir, '__init__.py'), 'utf8')).toBe(edited);
  });

  it('uninstall removes managed files, launcher.json, __pycache__ and empty dir, and keeps extra user files', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const first = installHermes(homes);
    const pycache = path.join(first.pluginDir, '__pycache__');
    fs.mkdirSync(pycache, { recursive: true });
    fs.writeFileSync(path.join(pycache, '__init__.cpython-312.pyc'), 'pyc');

    const removed = uninstallHermes(homes);
    expect(removed.status).toBe('removed');
    expect(hermesRemoveLines(removed)).toEqual([`Removed the hippo memory provider from ${first.pluginDir}`]);
    expect(fs.existsSync(first.pluginDir)).toBe(false);

    const again = uninstallHermes(homes);
    expect(again.status).toBe('absent');
    expect(hermesRemoveLines(again)).toEqual([`No hippo memory provider found in ${first.pluginDir}`]);

    expect(installHermes(homes).status).toBe('installed');
    const extra = path.join(first.pluginDir, 'my-notes.txt');
    fs.writeFileSync(extra, 'keep me\n');
    const outsideDir = path.join(root, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'precious.txt');
    fs.writeFileSync(outsideFile, 'do not touch\n');
    fs.symlinkSync(outsideDir, pycache, process.platform === 'win32' ? 'junction' : 'dir');
    expect(uninstallHermes(homes).status).toBe('removed');
    expect(fs.existsSync(first.pluginDir)).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.lstatSync(pycache).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(extra, 'utf8')).toBe('keep me\n');
  });

  it('returns no-home and creates nothing when the Hermes home does not exist', () => {
    const root = makeRoot();
    const missing = path.join(root, 'missing-hermes');
    const homes: Homes = { home: root, env: { HERMES_HOME: missing } };

    expect(isHermesPresent(homes)).toBe(false);
    const result = installHermes(homes);
    expect(result.status).toBe('no-home');
    expect(fs.existsSync(missing)).toBe(false);
    expect(hermesInstallLines(result)).toEqual([`No Hermes home at ${missing}; install Hermes or set HERMES_HOME`]);
  });

  it('reports a failure when pluginDir is a file instead of a directory', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.writeFileSync(pluginDir, 'not a dir');
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const installed = installHermes(homes);
    expect(installed.status).toEqual({ failed: `${pluginDir} is not a directory` });
    expect(hermesInstallLines(installed)[0]).toContain('WARNING: hippo could not use');

    const removed = uninstallHermes(homes);
    expect(removed.status).toEqual({ failed: `${pluginDir} is not a directory` });
    expect(hermesRemoveLines(removed)[0]).toContain('WARNING: hippo could not use');
  });

  it('refuses a symlinked pluginDir without touching its target', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    const outsideDir = path.join(root, 'outside-plugin');
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'keep.txt');
    fs.writeFileSync(outsideFile, 'precious\n');
    fs.symlinkSync(outsideDir, pluginDir, process.platform === 'win32' ? 'junction' : 'dir');
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    expect(installHermes(homes).status).toEqual({ failed: `${pluginDir} is not a directory` });
    expect(uninstallHermes(homes).status).toEqual({ failed: `${pluginDir} is not a directory` });
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('precious\n');
    expect(fs.existsSync(path.join(outsideDir, 'launcher.json'))).toBe(false);
  });

  it('refuses linked managed files inside pluginDir without touching external targets', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const first = installHermes(homes);
    expect(first.status).toBe('installed');

    const outside = path.join(root, 'outside-init.py');
    fs.writeFileSync(outside, fs.readFileSync(path.join(SOURCE_DIR, '__init__.py')));
    const initPath = path.join(first.pluginDir, '__init__.py');
    fs.unlinkSync(initPath);
    try {
      fs.symlinkSync(outside, initPath);
    } catch {
      fs.mkdirSync(initPath);
    }

    expect(installHermes(homes).status).toEqual({ failed: `${initPath} is not a regular file` });
    expect(uninstallHermes(homes).status).toEqual({ failed: `${initPath} is not a regular file` });
    expect(fs.readFileSync(outside).equals(fs.readFileSync(path.join(SOURCE_DIR, '__init__.py')))).toBe(true);
  });

  it('stages a fresh install cleanly and stays retryable after a blocked parent directory', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    const pluginsDir = path.join(hermesHome, 'plugins');
    fs.writeFileSync(pluginsDir, 'blocking file');
    const homes: Homes = { home: root, env: { HERMES_HOME: hermesHome } };

    const blocked = installHermes(homes);
    expect(isHermesFailure(blocked.status)).toBe(true);
    fs.unlinkSync(pluginsDir);

    const retried = installHermes(homes);
    expect(retried.status).toBe('installed');
    expect(fs.readdirSync(pluginsDir)).toEqual(['hippo']);
    expect(fs.existsSync(path.join(retried.pluginDir, 'launcher.json'))).toBe(true);
  });
});

describe('hippo CLI wire-up with Hermes', () => {
  it('detects Hermes as a plugin tool only when its home exists', () => {
    const root = makeRoot();
    const hermesHome = path.join(root, 'hermes');
    vi.stubEnv('HERMES_HOME', hermesHome);

    expect(detectInstalledTools().find((t) => t.name === 'hermes')).toMatchObject({
      name: 'hermes',
      kind: 'plugin',
      configDir: hermesHome,
      detected: false,
    });

    fs.mkdirSync(hermesHome, { recursive: true });
    expect(detectInstalledTools().find((t) => t.name === 'hermes')).toMatchObject({
      name: 'hermes',
      kind: 'plugin',
      configDir: hermesHome,
      detected: true,
    });
  });

  it('supports hook list, hook install hermes and hook uninstall hermes', async () => {
    const m = makeMachine();
    const hermesHome = nativeHermesDir(m.home, m.localAppData);
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    fs.mkdirSync(hermesHome, { recursive: true });

    const list = await hippo(m, 'hook', 'list');
    expect(list).toContain(`hermes          -> ${pluginDir}`);

    const install = await hippo(m, 'hook', 'install', 'hermes');
    expect(install).toContain(`Copied the hippo memory provider -> ${pluginDir}`);
    expect(install).toContain('Turn it on: hermes config set memory.provider hippo');
    expect(fs.existsSync(path.join(pluginDir, 'launcher.json'))).toBe(true);

    const uninstall = await hippo(m, 'hook', 'uninstall', 'hermes');
    expect(uninstall).toContain(`Removed the hippo memory provider from ${pluginDir}`);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it('wires into hippo init when Hermes home exists and creates nothing when absent', async () => {
    const absent = makeMachine();
    const absentHermes = nativeHermesDir(absent.home, absent.localAppData);
    await hippo(absent, 'init', '--no-learn', '--no-schedule', '--no-embeddings');
    expect(fs.existsSync(absentHermes)).toBe(false);

    const present = makeMachine();
    const hermesHome = nativeHermesDir(present.home, present.localAppData);
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    fs.mkdirSync(hermesHome, { recursive: true });

    const out = await hippo(present, 'init', '--no-learn', '--no-schedule', '--no-embeddings');
    expect(out).toContain(`Copied the hippo memory provider -> ${pluginDir}`);
    expect(out).toContain('Turn it on: hermes config set memory.provider hippo');
    expect(fs.existsSync(path.join(pluginDir, '__init__.py'))).toBe(true);
    expect(fs.existsSync(path.join(hermesHome, 'config.yaml'))).toBe(false);
  });

  it('wires into hippo setup --dry-run and hippo setup', async () => {
    const m = makeMachine();
    const hermesHome = nativeHermesDir(m.home, m.localAppData);
    const pluginDir = path.join(hermesHome, 'plugins', 'hippo');
    fs.mkdirSync(hermesHome, { recursive: true });

    const dry = await hippo(m, 'setup', '--dry-run', '--no-learn', '--no-schedule');
    expect(dry).toContain(`[dry-run] would copy the hippo memory provider to ${pluginDir}`);
    expect(fs.existsSync(pluginDir)).toBe(false);

    const real = await hippo(m, 'setup', '--no-learn', '--no-schedule');
    expect(real).toContain(`Copied the hippo memory provider -> ${pluginDir}`);
    expect(real).toContain('Turn it on: hermes config set memory.provider hippo');
    expect(fs.existsSync(path.join(pluginDir, 'plugin.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(hermesHome, 'config.yaml'))).toBe(false);
  });
});
