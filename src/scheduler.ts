import * as fs from 'fs';
import * as path from 'path';

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
  writeFileSync: typeof fs.writeFileSync;
}

let fsDeps: SchedulerFsDeps = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
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

  try {
    const parsed: Partial<WorkspaceRegistry> = JSON.parse(fsDeps.readFileSync(registryPath, 'utf8'));
    const workspaces = Array.isArray(parsed.workspaces)
      ? [...new Set(parsed.workspaces.map((entry) => normalizeWorkspace(String(entry))).filter(Boolean))].sort()
      : [];
    return {
      version: 1,
      workspaces,
    };
  } catch {
    return defaultRegistry();
  }
}

export function saveWorkspaceRegistry(globalRoot: string, registry: WorkspaceRegistry): void {
  fsDeps.mkdirSync(globalRoot, { recursive: true });
  fsDeps.writeFileSync(
    workspaceRegistryPath(globalRoot),
    JSON.stringify(
      {
        version: 1,
        workspaces: [...new Set(registry.workspaces.map(normalizeWorkspace))].sort(),
      },
      null,
      2,
    ) + '\n',
    'utf8',
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
