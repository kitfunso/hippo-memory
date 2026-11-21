// `hippo init` installs Copilot's files when the Copilot CLI is installed, with the installer `hippo setup` uses.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';

const START = '<!-- hippo:start -->';
const HOOK_EVENTS = ['sessionStart', 'postToolUseFailure', 'preCompact', 'PreCompact', 'agentStop', 'sessionEnd'];
const INSTALLED = "Installed hippo's Copilot hooks";
const RETRY = 'hippo hook install copilot';

const savedCwd = process.cwd();
let home: string;
let copilotHome: string;
let vscodeUser: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-init-copilot-'));
  copilotHome = path.join(home, 'copilot-home');
  vscodeUser = path.join(home, 'vscode-data', 'Code', 'User');
  project = path.join(home, 'code', 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HIPPO_HOME', path.join(home, 'global'));
  vi.stubEnv('COPILOT_HOME', copilotHome);
  // VS Code's own override, so its User folder sits under the fake home on every platform.
  vi.stubEnv('VSCODE_APPDATA', path.join(home, 'vscode-data'));
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The Copilot CLI's folder as the CLI leaves it: more than the hooks folder. */
function copilotCli(): void {
  fs.mkdirSync(copilotHome, { recursive: true });
  fs.writeFileSync(path.join(copilotHome, 'config.json'), '{}\n');
}

const readJson = (file: string): JsonValue => JSON.parse(fs.readFileSync(file, 'utf8'));
const hooksFile = (): string => path.join(copilotHome, 'hooks', 'hippo.json');

// Without --no-schedule the run would register a real OS task, without --no-learn it would run git.
async function runInit(cwd: string, ...args: string[]): Promise<InProcessResult> {
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args, '--no-schedule', '--no-learn']));
    return { ...r, status: r.status || Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = undefined;
  }
}

async function hippo(cwd: string, ...args: string[]): Promise<InProcessResult> {
  const r = await runInit(cwd, ...args);
  expect(r.status, r.stderr).toBe(0);
  return r;
}

const busy = (op: string): Error =>
  Object.assign(new Error(`EBUSY: resource busy or locked, ${op}`), { code: 'EBUSY', syscall: 'open' });

/** Fails every rename onto, and every in-place write of, a file under the Copilot home; every other path goes through.
 * The rename fails with EXDEV, which renameOnto does not retry, so the write falls back to in place; that write fails with `fail`. */
function refuseCopilotWrites(fail: (op: string) => Error): void {
  const rename = fs.renameSync.bind(fs);
  const write = fs.writeFileSync.bind(fs);
  // writeFileAtomic writes its temp file through an fd, and String(fd) never names a Copilot path.
  const underCopilot = (p: fs.PathOrFileDescriptor): boolean => String(p).startsWith(copilotHome + path.sep);
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (underCopilot(to)) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
    }
    rename(from, to);
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (underCopilot(file)) throw fail('open');
    write(file, data, options);
  });
  syncBuiltinESMExports();
}

describe('hippo init and the Copilot CLI', () => {
  it('plain init in a project with no agent files installs the Copilot CLI and VS Code files', async () => {
    copilotCli();
    fs.mkdirSync(vscodeUser, { recursive: true });

    const { stdout } = await hippo(project, 'init');

    expect(readJson(hooksFile())).toMatchObject({
      version: 1,
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, expect.any(Array)])),
    });
    expect(readJson(path.join(copilotHome, 'mcp-config.json'))).toMatchObject({
      mcpServers: { hippo: { args: ['mcp'] } },
    });
    expect(fs.readFileSync(path.join(copilotHome, 'copilot-instructions.md'), 'utf8')).toContain(START);
    expect(readJson(path.join(vscodeUser, 'mcp.json'))).toMatchObject({ servers: { hippo: { args: ['mcp'] } } });
    expect(fs.existsSync(path.join(vscodeUser, 'prompts', 'hippo.instructions.md'))).toBe(true);
    expect(stdout).toContain(INSTALLED);
  });

  it('a second init changes no Copilot byte and says the files are already in', async () => {
    copilotCli();
    fs.mkdirSync(vscodeUser, { recursive: true });
    const files = [
      hooksFile(),
      path.join(copilotHome, 'mcp-config.json'),
      path.join(copilotHome, 'copilot-instructions.md'),
      path.join(vscodeUser, 'mcp.json'),
      path.join(vscodeUser, 'prompts', 'hippo.instructions.md'),
    ];
    await hippo(project, 'init');
    const first = files.map((f) => fs.readFileSync(f, 'utf8'));

    const second = await hippo(project, 'init');

    expect(files.map((f) => fs.readFileSync(f, 'utf8'))).toEqual(first);
    expect(second.stdout).toContain("hippo's Copilot hooks are already in");
  });

  it('leaves Copilot alone when its folder is missing or holds only hooks/, with VS Code present', async () => {
    fs.mkdirSync(vscodeUser, { recursive: true });

    const first = await hippo(project, 'init');
    expect(fs.existsSync(copilotHome)).toBe(false);

    fs.mkdirSync(path.join(copilotHome, 'hooks'), { recursive: true });
    const second = await hippo(project, 'init');

    expect(fs.readdirSync(copilotHome)).toEqual(['hooks']);
    expect(fs.readdirSync(path.join(copilotHome, 'hooks'))).toEqual([]);
    expect(fs.existsSync(path.join(vscodeUser, 'mcp.json'))).toBe(false);
    expect(first.stdout + second.stdout).not.toContain('Copilot');
  });

  it('--no-hooks and HIPPO_SKIP_AUTO_INTEGRATIONS=1 leave the Copilot folder alone', async () => {
    copilotCli();

    await hippo(project, 'init', '--no-hooks');
    expect(fs.readdirSync(copilotHome)).toEqual(['config.json']);

    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(project, 'init');
    expect(fs.readdirSync(copilotHome)).toEqual(['config.json']);
  });

  it('init --scan installs the Copilot files once', async () => {
    copilotCli();
    fs.mkdirSync(path.join(home, 'code', 'alpha', '.git'), { recursive: true });

    const { stdout } = await hippo(home, 'init', '--scan', home);

    expect(fs.existsSync(hooksFile())).toBe(true);
    expect(stdout.split(INSTALLED)).toHaveLength(2);
  });

  it('a Copilot file init cannot read gives a warning, and the rest of init still runs', async () => {
    copilotCli();
    // A folder where the instructions file belongs: reading it fails with EISDIR on every platform.
    fs.mkdirSync(path.join(copilotHome, 'copilot-instructions.md'));
    fs.mkdirSync(path.join(home, 'code', 'alpha', '.git'), { recursive: true });

    const { stdout, stderr } = await hippo(home, 'init', '--scan', home);

    expect(stderr).toContain(RETRY);
    expect(stdout).toContain('Run `hippo sleep` in any project');
    expect(fs.existsSync(hooksFile())).toBe(true);
  });

  it('a Copilot file another program holds open gives a warning, and the rest of init still runs', async () => {
    copilotCli();
    fs.mkdirSync(path.join(home, 'code', 'alpha', '.git'), { recursive: true });
    // How Windows refuses a file VS Code holds open: the rename and the in-place write both fail.
    refuseCopilotWrites(busy);

    const { stdout, stderr } = await hippo(home, 'init', '--scan', home);

    expect(stderr).toContain('is in use by another program');
    expect(stderr).toContain(RETRY);
    expect(stdout).toContain('Run `hippo sleep` in any project');
    expect(fs.existsSync(hooksFile())).toBe(false);
  });

  it('an error with no errno fails init, as a bug should', async () => {
    copilotCli();
    fs.mkdirSync(path.join(home, 'code', 'alpha', '.git'), { recursive: true });
    refuseCopilotWrites(() => new Error('a bug in the Copilot install'));

    const r = await runInit(home, 'init', '--scan', home);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a bug in the Copilot install');
    expect(r.stderr).not.toContain(RETRY);
  });

  it('a Node argument error, which has a code but no syscall, fails init, as a bug should', async () => {
    copilotCli();
    fs.mkdirSync(path.join(home, 'code', 'alpha', '.git'), { recursive: true });
    refuseCopilotWrites(() => Object.assign(new TypeError('bad arg'), { code: 'ERR_INVALID_ARG_TYPE' }));

    const r = await runInit(home, 'init', '--scan', home);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERR_INVALID_ARG_TYPE');
    expect(r.stderr).not.toContain(RETRY);
  });
});
