// GitHub Copilot Chat in VS Code: memory-tool files under VS Code's own data folders, one set per product and
// workspace.
import path from 'node:path';
import type { AgentFiles } from '../../base/util/agent-files.js';
import { readFolderStore, type FolderRules } from './folder-store.js';
import { gitLayout } from './git.js';
import type { Adapter, AdapterContext, Container } from './types.js';
import { errorMessage } from '../../base/util/log.js';
import { isJsonObject, isJsonString, parseJson } from '../../base/util/json.js';
import { vscodeDataFolders } from '../../base/util/agent-homes.js';

const MEMORY_TOOL = ['github.copilot-chat', 'memory-tool', 'memories'] as const;

/** A `file:` URI as a local path; null for any other scheme or a URI with a host part. */
function fileUriToPath(uri: string, platform: NodeJS.Platform): string | null {
  if (!uri.startsWith('file://')) return null;
  const rest = decodeURIComponent(uri.slice('file://'.length));
  if (!rest.startsWith('/')) return null;
  return platform === 'win32' ? rest.replace(/^\/(?=[a-zA-Z]:)/, '').replace(/\//g, '\\') : rest;
}

/** The workspace's single folder as a path; null (with a warning when the file is unusable) for anything else. */
function workspaceFolder(
  files: AgentFiles,
  file: string,
  platform: NodeJS.Platform,
  warnings: string[],
): string | null {
  const read = files.readText(file);
  if (!read.ok) {
    warnings.push(read.reason);
    return null;
  }
  try {
    // A scalar file or a non-string `folder` throws and becomes a warning.
    const json = parseJson(read.text);
    if (!isJsonObject(json)) throw new Error('not a JSON object');
    if ('workspace' in json || !json.folder) return null;
    if (!isJsonString(json.folder)) throw new Error('folder is not a string');
    return fileUriToPath(json.folder, platform);
  } catch (err) {
    warnings.push(`${file}: ${errorMessage(err)}`);
    return null;
  }
}

/** Matches the project root exactly, or its git top level; git is asked once, and only when a folder needs it. */
function projectMatcher(ctx: AdapterContext, projectRoot: string): (folder: string) => boolean {
  const fold = (p: string): string => (ctx.platform === 'win32' ? p.toLowerCase() : p);
  const root = fold(path.resolve(projectRoot));
  let top: string | null | undefined;
  return (folder) => {
    const wanted = fold(folder);
    if (wanted === root) return true;
    if (top === undefined) {
      const layout = gitLayout(ctx.git, projectRoot);
      top = layout === null ? null : fold(path.resolve(layout.top));
    }
    return wanted === top;
  };
}

const EVERY_FILE: FolderRules = {
  recursive: true,
  include: () => true,
  item: (text, mtimeMs) => ({ text: text.trim(), updatedAt: mtimeMs }),
};

function projectContainers(
  data: string,
  ctx: AdapterContext,
  matches: (f: string) => boolean,
  warnings: string[],
): Container[] {
  const storage = path.join(data, 'User', 'workspaceStorage');
  if (!ctx.files.exists(storage)) return [];
  let ids: string[];
  try {
    ids = ctx.files.folderNames(storage);
  } catch (err) {
    warnings.push(`${storage}: ${errorMessage(err)}`);
    return [];
  }
  const found: Container[] = [];
  for (const id of ids) {
    const repo = path.join(storage, id, ...MEMORY_TOOL, 'repo');
    if (!ctx.files.isFolder(repo)) continue;
    const folder = workspaceFolder(ctx.files, path.join(storage, id, 'workspace.json'), ctx.platform, warnings);
    const container =
      folder !== null && matches(folder) ? readFolderStore(ctx.files, repo, 'project', EVERY_FILE) : null;
    if (container) found.push(container);
  }
  return found;
}

export const copilotAdapter: Adapter = {
  tool: 'copilot',
  list(ctx, scope) {
    const data = vscodeDataFolders(ctx);
    const warnings: string[] = [];
    const found: Container[] = [];
    if (scope === 'user') {
      for (const dir of data) {
        const store = path.join(dir, 'User', 'globalStorage', ...MEMORY_TOOL);
        const container = readFolderStore(ctx.files, store, 'user', EVERY_FILE);
        if (container) found.push(container);
      }
    } else if (ctx.projectRoot !== undefined) {
      const matches = projectMatcher(ctx, ctx.projectRoot);
      for (const dir of data) found.push(...projectContainers(dir, ctx, matches, warnings));
    }
    const home = data.find((dir) => ctx.files.exists(dir)) ?? data[0];
    return { tool: 'copilot', home, containers: found, warnings };
  },
};
