// Claude Code's auto memory: frontmatter `.md` notes in a per-project folder, plus the `autoMemoryDirectory` user folder.
import fs from 'node:fs';
import path from 'node:path';
import { deriveOriginProject, realpathOrResolve } from '../project-identity.js';
import { isStringValue } from '../capture-contract.js';
import { isJsonObject } from '../hooks/shared.js';
import type { JsonValue } from '../working-memory.js';
import { expandHome, frontmatterField, itemTime, readTextFile, splitFrontmatter } from './files.js';
import { markdownNotes, readFolderStore, uniqueFolders, type FolderRules } from './folder-store.js';
import { gitLayout } from './git.js';
import type { Adapter, AdapterContext, Container, Listing, Scope } from './types.js';

// Keeps a pinned name from carrying a separator or `..` out of the projects folder.
const PROJECT_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Claude Code's auto memory folder names for a project: its checkout, which subfolders share, or the folder itself outside a repository. */
export function claudeMemoryFolderNames(projectRoot: string, platform: NodeJS.Platform): Set<string> {
  const roots = [projectRoot, realpathOrResolve(projectRoot)];
  const layout = gitLayout(projectRoot);
  if (layout) roots.push(claudeCheckoutRoot(layout.top, layout.gitDir, layout.common));
  return new Set(roots.map((root) => (platform === 'win32' ? claudeFolderName(root).toLowerCase() : claudeFolderName(root))));
}

/** Claude Code's rule: a linked worktree shares its main checkout's folder, or the git folder's when that sits outside a checkout (a bare repository, or --separate-git-dir); any other checkout, a submodule included, keeps its own. */
export function claudeCheckoutRoot(top: string, gitDir: string, common: string): string {
  if (gitDir === common) return top;
  if (path.basename(common) === '.git') return path.dirname(common);
  return fs.existsSync(path.join(common, '.git')) ? top : common;
}

/** Claude Code's folder name for a path: non-alphanumerics made '-', and a name over 200 characters cut to 200 plus a base-36 hash of the whole path. */
export function claudeFolderName(root: string): string {
  const full = path.resolve(root);
  const name = full.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < full.length; i++) hash = ((hash << 5) - hash + full.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export const claudeCodeAdapter: Adapter = {
  tool: 'claude-code',
  list(ctx, scope) {
    const config = ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
    const warnings: string[] = [];
    const folders = scope === 'project' ? projectFolders(ctx, config) : userFolders(ctx, config, warnings);
    return { tool: 'claude-code', home: config, containers: readFolders(folders, scope, ctx.platform), warnings };
  },
};

/** A session's own notes folder and nothing else, with no git call, so post-compact can read it inside the hook's time limit. */
export function claudeTranscriptListing(ctx: AdapterContext, transcriptPath: string): Listing {
  const config = ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
  const folder = path.join(path.dirname(transcriptPath), 'memory');
  return { tool: 'claude-code', home: config, containers: readFolders([folder], 'project', ctx.platform), warnings: [] };
}

/** The project a session folder's notes belong to: the one Claude named the folder for, which is cwd or a parent; null when it is neither. */
export function transcriptNotesOrigin(transcriptPath: string, cwd: string | null, platform: NodeJS.Platform): string | null {
  if (cwd === null) return null;
  const fold = (name: string) => (platform === 'win32' ? name.toLowerCase() : name);
  const folder = fold(path.basename(path.dirname(transcriptPath)));
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if ([dir, realpathOrResolve(dir)].some((d) => fold(claudeFolderName(d)) === folder)) return deriveOriginProject(dir);
    if (path.dirname(dir) === dir) return null;
  }
}

function projectFolders(ctx: AdapterContext, config: string): string[] {
  const projects = path.join(config, 'projects');
  const names = ctx.projectRoot === undefined ? [] : [...claudeMemoryFolderNames(ctx.projectRoot, ctx.platform)];
  const pinned = ctx.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  // Claude reads the pinned name only alongside a pinned config folder.
  if (ctx.env.CLAUDE_CONFIG_DIR && pinned !== undefined && PROJECT_DIR_NAME.test(pinned)) names.push(pinned);
  return names.map((name) => path.join(projects, name, 'memory'));
}

function userFolders(ctx: AdapterContext, config: string, warnings: string[]): string[] {
  const dir = autoMemoryDirectory(path.join(config, 'settings.json'), ctx.home, warnings);
  return dir === null ? [] : [dir];
}

// User settings only: a cloned repository's own settings must not point the import at another project's notes.
function autoMemoryDirectory(settings: string, home: string, warnings: string[]): string | null {
  if (!fs.existsSync(settings)) return null;
  const file = readTextFile(settings);
  if (!file.ok) {
    warnings.push(file.reason);
    return null;
  }
  let json: JsonValue;
  try {
    // SAFETY: JSON.parse yields JSON; the object and string checks below decide what is used.
    json = JSON.parse(file.text) as JsonValue;
  } catch (err) {
    warnings.push(`${settings}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const value = isJsonObject(json) ? json.autoMemoryDirectory : undefined;
  if (!isStringValue(value) || value === '') return null;
  const dir = expandHome(value, home);
  if (path.isAbsolute(dir)) return dir;
  warnings.push(`${settings}: autoMemoryDirectory "${value}" is not absolute or under ~/, so it is ignored`);
  return null;
}

// Claude counts a note only when it carries frontmatter; `modified` there beats the file time.
const NOTES: FolderRules = {
  recursive: false,
  include: markdownNotes,
  item(text, mtimeMs) {
    const { yaml, body } = splitFrontmatter(text);
    if (yaml === null) return null;
    return { text: body.trim(), updatedAt: itemTime(frontmatterField(yaml, 'modified'), mtimeMs) };
  },
};

function readFolders(folders: readonly string[], scope: Scope, platform: NodeJS.Platform): Container[] {
  return uniqueFolders(folders, platform)
    .map((dir) => readFolderStore(dir, scope, NOTES))
    .filter((c): c is Container => c !== null);
}
