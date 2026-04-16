import * as fs from 'fs';
import * as path from 'path';

export const DAILY_TASK_NAME = 'hippo-daily-runner';

interface WorkspaceRegistry {
  version: 1;
  workspaces: string[];
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
  if (!fs.existsSync(registryPath)) return defaultRegistry();

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Partial<WorkspaceRegistry>;
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
  fs.mkdirSync(globalRoot, { recursive: true });
  fs.writeFileSync(
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
    if (!fs.existsSync(path.join(resolved, '.hippo'))) continue;
    runCommand(resolved, ['learn', '--git', '--days', '1']);
    runCommand(resolved, ['sleep']);
  }
}
