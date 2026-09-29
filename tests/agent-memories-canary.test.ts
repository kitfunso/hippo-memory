// Real homes are never read: the process's homes and tool variables point at canaries, the injected machine at a clean tree.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeFolderName } from '../src/agent-memories/claude-code.js';
import { sanitizeCwd } from '../src/agent-memories/qwen-code.js';
import { AGENT_MEMORY_TOOLS } from '../src/agent-memories/tools.js';
import { initStore, isInitialized, loadAllEntries } from '../src/store.js';
import {
  assertFreshDist, closeWorld, codexSummary, distUrl, dormantRows, liveRows, liveTexts, note, openWorld, projectNotes, type World,
} from './_helpers/agent-memories-world.js';

const WORKER = `
const [, , syncUrl, mode, root, cleanHome, storeless] = process.argv;
const { importForStore, importAtSessionEnd, currentMachine } = await import(syncUrl);
const { homedir } = await import('node:os');
const machine = mode === 'negative' ? { home: cleanHome, env: {}, platform: process.platform }
  : mode === 'env' ? currentMachine() : { home: homedir(), env: {}, platform: process.platform };
const warnings = [...importForStore(root, { machine }).warnings];
if (mode === 'negative') warnings.push(...importAtSessionEnd(storeless, undefined, { machine }).warnings);
process.stdout.write(JSON.stringify({ warnings }));
`;
const CLEAN_PROJECT = 'Clean project note for the injected machine.';
const CLEAN_STORELESS = 'Clean store-less note for the injected machine.';
const CLEAN_BULLET = 'Clean Codex bullet for the injected machine.';

interface WorkerOut {
  readonly warnings: string[];
}

interface Run {
  readonly local: string;
  readonly global: string;
}

let w: World;
let decoy: string;
let decoyEnv: NodeJS.ProcessEnv;
let storeless: string;
let ctrlEnv: Run;
let ctrlHome: Run;

function plain(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

const canary = (dir: string, label: string): string => note(dir, 'canary.md', `CANARY ${label} note.`);

function claudeTree(config: string, label: string, projects: readonly string[], userDir: string): void {
  for (const p of projects) canary(join(config, 'projects', claudeFolderName(p), 'memory'), `${label} claude project`);
  plain(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: userDir }));
  canary(userDir, `${label} claude user`);
}

function geminiTree(gemini: string, label: string, projects: readonly string[]): void {
  plain(join(gemini, 'GEMINI.md'), ['## Gemini Added Memories', '', `- CANARY ${label} gemini user.`, ''].join('\n'));
  plain(join(gemini, 'projects.json'), JSON.stringify({ projects: Object.fromEntries(projects.map((p, i) => [p, `slug${i}`])) }));
  projects.forEach((_, i) => canary(join(gemini, 'tmp', `slug${i}`, 'memory'), `${label} gemini project`));
}

function copilotTree(data: string, label: string, projects: readonly string[]): void {
  canary(join(data, 'User', 'globalStorage', 'github.copilot-chat', 'memory-tool', 'memories'), `${label} copilot user`);
  projects.forEach((p, i) => {
    const ws = join(data, 'User', 'workspaceStorage', `ws${i}`);
    plain(join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(p).href }));
    canary(join(ws, 'github.copilot-chat', 'memory-tool', 'memories', 'repo'), `${label} copilot project`);
  });
}

function qwenTree(base: string, label: string, projects: readonly string[]): void {
  canary(join(base, 'memories'), `${label} qwen user`);
  for (const p of projects) canary(join(base, 'projects', sanitizeCwd(p, process.platform), 'memory'), `${label} qwen project`);
}

const codexTree = (codexHome: string, label: string): void =>
  plain(join(codexHome, 'memories', 'memory_summary.md'), ['v1', '', '## User Profile', '', `- CANARY ${label} codex bullet.`, ''].join('\n'));

const openclawTree = (workspace: string, label: string): void => plain(join(workspace, 'MEMORY.md'), `- CANARY ${label} openclaw memory.\n`);

/** Canaries at every tool's home default and at every variable's folder; returns the variables. */
function plantDecoys(root: string, projects: readonly string[]): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const env = (name: string): string => join(root, 'env', name);
  claudeTree(join(home, '.claude'), 'home', projects, join(home, 'claude-user'));
  codexTree(join(home, '.codex'), 'home');
  geminiTree(join(home, '.gemini'), 'home', projects);
  for (const appData of [join(home, 'AppData', 'Roaming'), join(home, '.config'), join(home, 'Library', 'Application Support')]) {
    copilotTree(join(appData, 'Code'), 'home', projects);
  }
  openclawTree(join(home, '.openclaw', 'workspace'), 'home');
  qwenTree(join(home, '.qwen'), 'home', projects);

  claudeTree(env('claude'), 'env', projects, env('claude-user'));
  canary(join(env('claude'), 'projects', 'pinned-canary', 'memory'), 'env claude pinned');
  codexTree(env('codex'), 'env');
  geminiTree(join(env('gemini'), '.gemini'), 'env', projects);
  for (const name of ['vscode-appdata', 'appdata', 'xdg']) copilotTree(join(env(name), 'Code'), `env ${name}`, projects);
  copilotTree(join(env('vscode-portable'), 'user-data'), 'env portable', projects);
  openclawTree(join(env('openclaw-home'), '.openclaw', 'workspace'), 'env home');
  openclawTree(join(env('openclaw-state'), 'workspace'), 'env state');
  openclawTree(env('openclaw-workspace'), 'env workspace');
  for (const name of ['qwen-home', 'qwen-runtime', 'qwen-base']) qwenTree(env(name), `env ${name}`, projects);
  for (const p of projects) canary(join(p, '.qwen', 'memory'), 'env qwen local');
  return {
    HOME: home, USERPROFILE: home, APPDATA: env('appdata'), XDG_CONFIG_HOME: env('xdg'), XDG_DATA_HOME: env('xdg-data'),
    CLAUDE_CONFIG_DIR: env('claude'), CLAUDE_CODE_PROJECT_DIR_NAME: 'pinned-canary', CODEX_HOME: env('codex'), GEMINI_CLI_HOME: env('gemini'),
    VSCODE_APPDATA: env('vscode-appdata'), VSCODE_PORTABLE: env('vscode-portable'),
    OPENCLAW_HOME: env('openclaw-home'), OPENCLAW_STATE_DIR: env('openclaw-state'), OPENCLAW_WORKSPACE_DIR: env('openclaw-workspace'),
    QWEN_HOME: env('qwen-home'), QWEN_RUNTIME_DIR: env('qwen-runtime'), QWEN_CODE_MEMORY_BASE_DIR: env('qwen-base'), QWEN_CODE_MEMORY_LOCAL: '1',
  };
}

function project(name: string): string {
  const dir = join(w.dir, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function controlRun(name: string): Run {
  const local = join(project(name), '.hippo');
  initStore(local);
  return { local, global: join(w.dir, `${name}-global`) };
}

function runWorker(mode: string, run: Run, extraEnv: NodeJS.ProcessEnv): Promise<WorkerOut> {
  const args = [join(w.dir, 'worker.mjs'), distUrl('agent-memories/sync.js'), mode, run.local, w.home, storeless];
  const env = { ...process.env, ...decoyEnv, HIPPO_HOME: run.global, ...extraEnv };
  return new Promise((resolve, fail) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`${mode} worker exited ${code}: ${stderr}`));
        return;
      }
      // SAFETY: the worker prints one JSON object with a warnings list.
      resolve(JSON.parse(stdout) as WorkerOut);
    });
  });
}

const everyText = (root: string): string[] =>
  isInitialized(root) ? [...loadAllEntries(root).map((e) => e.content), ...dormantRows(root).map((d) => d.content)] : [];

beforeEach(() => {
  w = openWorld();
  assertFreshDist('agent-memories/sync.js');
  writeFileSync(join(w.dir, 'worker.mjs'), WORKER, 'utf8');
  mkdirSync(join(w.project, '.git'));
  storeless = project('storeless');
  ctrlEnv = controlRun('ctrl-env');
  ctrlHome = controlRun('ctrl-home');
  decoy = join(w.dir, 'decoy');
  decoyEnv = plantDecoys(decoy, [w.project, storeless, dirname(ctrlEnv.local), dirname(ctrlHome.local)]);
  note(projectNotes(w), 'clean.md', CLEAN_PROJECT);
  note(projectNotes(w, storeless), 'clean.md', CLEAN_STORELESS);
  codexSummary(w, `- ${CLEAN_BULLET}`);
});
afterEach(() => closeWorld(w));

describe('agent memory sync: real homes are never read', () => {
  it('no canary is imported when the process points every home and tool variable at a decoy tree', async () => {
    const out = await runWorker('negative', { local: w.local, global: w.global }, { HIPPO_AGENT_MEMORY_TOOLS: 'none' });

    expect([...everyText(w.local), ...everyText(w.global)].filter((t) => t.includes('CANARY'))).toEqual([]);
    expect(out.warnings.filter((line) => line.includes(decoy))).toEqual([]);
    expect(liveTexts(w.local)).toEqual([CLEAN_PROJECT]);
    expect(liveTexts(w.global)).toEqual([CLEAN_STORELESS, `User Profile: ${CLEAN_BULLET}`].sort());
  }, 120_000);

  it('the decoys are real: the process machine and the decoy home each import a canary from every tool', async () => {
    await Promise.all([runWorker('env', ctrlEnv, {}), runWorker('home', ctrlHome, {})]);

    for (const run of [ctrlEnv, ctrlHome]) {
      const rows = [...liveRows(run.local), ...liveRows(run.global)].filter((e) => e.content.includes('CANARY'));
      const tagged = AGENT_MEMORY_TOOLS.map((t) => rows.some((e) => e.tags.includes(t.tag)));
      expect(tagged, run.local).toEqual(AGENT_MEMORY_TOOLS.map(() => true));
      const projectTags = new Set(liveRows(run.local).flatMap((e) => e.tags));
      expect(['claude-code-memory', 'gemini-memory', 'copilot-memory', 'qwen-code-memory'].filter((t) => !projectTags.has(t)), run.local).toEqual([]);
    }
  }, 120_000);
});
