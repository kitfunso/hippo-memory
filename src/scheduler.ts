import * as fs from 'fs';
import * as path from 'path';
import { log } from './log.js';
import { writeFileAtomic } from './util/atomic-write.js';

export const DAILY_TASK_NAME = 'hippo-daily-runner';

interface WorkspaceRegistry {
  version: 1;
  workspaces: string[];
}

/**
 * Dependency-injection seam for tests. Production code always uses the real
 * `fs` functions imported above; tests override this via
 * __setSchedulerFsDeps to substitute fakes instead of `vi.mock`ing the
 * built-in `fs` module. Never called outside tests -- this module's public
 * behavior is unaffected when it's never invoked.
 */
export interface SchedulerFsDeps {
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
  mkdirSync: typeof fs.mkdirSync;
  writeFile: (file: string, text: string) => void;
  renameSync: typeof fs.renameSync;
}

let fsDeps: SchedulerFsDeps = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  mkdirSync: fs.mkdirSync,
  // One rename, so a crash mid-save cannot leave a truncated registry that reads as corrupt.
  writeFile: writeFileAtomic,
  renameSync: fs.renameSync,
};

/** Test-only override. Not part of this module's public API surface. */
export function __setSchedulerFsDeps(overrides: Partial<SchedulerFsDeps>): void {
  fsDeps = { ...fsDeps, ...overrides };
}

function defaultRegistry(): WorkspaceRegistry {
  return {
    version: 1,
    workspaces: [],
  };
}

export function workspaceRegistryPath(globalRoot: string): string {
  return path.join(globalRoot, 'workspaces.json');
}

function normalizeWorkspace(projectDir: string): string {
  return path.resolve(projectDir).replace(/\\/g, '/');
}

export function loadWorkspaceRegistry(globalRoot: string): WorkspaceRegistry {
  const registryPath = workspaceRegistryPath(globalRoot);
  if (!fsDeps.existsSync(registryPath)) return defaultRegistry();

  let text: string;
  try {
    text = fsDeps.readFileSync(registryPath, 'utf8');
  } catch (err) {
    log.warn(`workspace registry ${registryPath} could not be read (${err instanceof Error ? err.message : String(err)}); starting with no workspaces`);
    return defaultRegistry();
  }
  try {
    const parsed: Partial<WorkspaceRegistry> = JSON.parse(text);
    const workspaces = Array.isArray(parsed.workspaces)
      ? [...new Set(parsed.workspaces.map((entry) => normalizeWorkspace(String(entry))).filter(Boolean))].sort()
      : [];
    return {
      version: 1,
      workspaces,
    };
  } catch (err) {
    // The next registration rewrites the file, so keep the bad copy for the user to recover entries from.
    setAsideCorruptRegistry(registryPath, err);
    return defaultRegistry();
  }
}

function setAsideCorruptRegistry<E>(registryPath: string, err: E): void {
  const reason = err instanceof Error ? err.message : String(err);
  const aside = `${registryPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fsDeps.renameSync(registryPath, aside);
    log.warn(`workspace registry ${registryPath} is corrupt (${reason}); moved it to ${aside} and starting with no workspaces`);
  } catch (renameErr) {
    log.warn(`workspace registry ${registryPath} is corrupt (${reason}) and could not be moved aside (${renameErr instanceof Error ? renameErr.message : String(renameErr)}); starting with no workspaces`);
  }
}

export function saveWorkspaceRegistry(globalRoot: string, registry: WorkspaceRegistry): void {
  fsDeps.mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  fsDeps.writeFile(
    workspaceRegistryPath(globalRoot),
    JSON.stringify(
      {
        version: 1,
        workspaces: [...new Set(registry.workspaces.map(normalizeWorkspace))].sort(),
      },
      null,
      2,
    ) + '\n',
  );
}

export function registerWorkspace(globalRoot: string, projectDir: string): WorkspaceRegistry {
  const registry = loadWorkspaceRegistry(globalRoot);
  registry.workspaces = [...new Set([...registry.workspaces, normalizeWorkspace(projectDir)])].sort();
  saveWorkspaceRegistry(globalRoot, registry);
  return registry;
}

export function listRegisteredWorkspaces(globalRoot: string): string[] {
  return loadWorkspaceRegistry(globalRoot).workspaces;
}

export function buildDailyRunnerCommand(
  projectDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const resolved = path.win32.resolve(projectDir).replace(/\\/g, '/');
    return `cd /d "${resolved}" && hippo daily-runner`;
  }
  const resolved = path.posix.resolve(projectDir.replace(/\\/g, '/'));
  return `cd "${resolved}" && hippo daily-runner`;
}

/** What the Windows task runs. A plain `cmd /c` task opens a visible console every morning. */
export function buildWindowsTaskRun(cmd: string): string {
  return `conhost.exe --headless cmd /c ${cmd}`;
}

/** Argv for `schtasks`, passed without a shell: through cmd.exe the `&&` in /tr split the command. */
export function buildSchtasksCreateArgs(taskName: string, cmd: string): string[] {
  return ['/create', '/tn', taskName, '/tr', buildWindowsTaskRun(cmd), '/sc', 'daily', '/st', '06:15', '/f'];
}

export function runDailyMaintenance(
  workspaces: readonly string[],
  runCommand: (cwd: string, args: string[]) => void,
): void {
  for (const workspace of workspaces) {
    const resolved = normalizeWorkspace(workspace);
    if (!fsDeps.existsSync(path.join(resolved, '.hippo'))) continue;
    runCommand(resolved, ['learn', '--git', '--days', '1']);
    runCommand(resolved, ['sleep']);
  }
}
