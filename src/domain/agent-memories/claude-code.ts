import path from 'node:path';
import { type ProjectIdentity } from '../../base/scope/project-identity.js';
import { isStringValue } from '../../base/session/capture-contract.js';
import { claudeConfigDir } from '../../base/util/agent-homes.js';
import type { AgentFiles } from '../../base/util/agent-files.js';
import { expandHome, frontmatterField, itemTime, splitFrontmatter } from './files.js';
import { markdownNotes, readFolderStore, uniqueFolders, type FolderRules } from './folder-store.js';
import { gitLayout, type GitLayout } from './git.js';
import type { Adapter, AdapterContext, Container, Listing } from './types.js';
import type { Scope } from '../../base/memory/agent-memory-tools.js';
import {
  isJsonObjectLiteral,
  isJsonString,
  parseJson,
  tryParseJson,
} from '../../base/util/json.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';

const NAME_SLUG_MAX_CHARS = 200;

const PROJECT_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function claudeMemoryFolderNames(ctx: AdapterContext, projectRoot: string): Set<string> {
  const roots = [projectRoot, ctx.files.realPath(projectRoot)];
  const layout = gitLayout(ctx.git, projectRoot);
  if (layout) roots.push(claudeCheckoutRoot(ctx.files, layout));
  const fold = (name: string): string => (ctx.platform === 'win32' ? name.toLowerCase() : name);
  return new Set(roots.map((root) => fold(claudeFolderName(root))));
}

function claudeCheckoutRoot(files: AgentFiles, { top, gitDir, common }: GitLayout): string {
  if (gitDir === common) return top;
  if (path.basename(common) === '.git') return path.dirname(common);
  return files.exists(path.join(common, '.git')) ? top : common;
}

/**
 * Claude Code's folder name for a path: non-alphanumerics made '-', and a name over 200 characters
 * cut to 200 plus a base-36 hash of the whole path.
 */
export function claudeFolderName(root: string): string {
  const full = path.resolve(root);
  const name = full.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= NAME_SLUG_MAX_CHARS) return name;
  let hash = 0;
  for (let i = 0; i < full.length; i++) hash = ((hash << 5) - hash + full.charCodeAt(i)) | 0;
  return `${name.slice(0, NAME_SLUG_MAX_CHARS)}-${Math.abs(hash).toString(36)}`;
}

export const claudeCodeAdapter: Adapter = {
  tool: 'claude-code',
  list(ctx, scope) {
    const config = claudeConfigDir(ctx.home, ctx.env);
    const warnings: string[] = [];
    const folders =
      scope === 'project' ? projectFolders(ctx, config) : userFolders(ctx, config, warnings);
    return {
      tool: 'claude-code',
      home: config,
      containers: readFolders(ctx, folders, scope),
      warnings,
    };
  },
};

/**
 * A session's own notes folder and nothing else, with no git call, so post-compact can read it
 * inside the hook's time limit.
 */
export function claudeTranscriptListing(ctx: AdapterContext, transcriptPath: string): Listing {
  const config = claudeConfigDir(ctx.home, ctx.env);
  const folder = path.join(path.dirname(transcriptPath), 'memory');
  return {
    tool: 'claude-code',
    home: config,
    containers: readFolders(ctx, [folder], 'project'),
    warnings: [],
  };
}

/** Whether `file` is a note in Claude Code's auto memory: a `.md` directly in
 * `<config>/projects/<name>/memory`, the MEMORY.md index left out. A hook runs this on every write,
 * so it reads nothing but the paths. */
export function isClaudeMemoryNote(
  file: string,
  machine: Pick<AdapterContext, 'home' | 'env' | 'platform' | 'files'>,
): boolean {
  const fold = (name: string): string => (machine.platform === 'win32' ? name.toLowerCase() : name);
  const forms = (p: string): string[] => [path.resolve(p), machine.files.realPath(p)].map(fold);
  const projects = path.join(claudeConfigDir(machine.home, machine.env), 'projects');
  return forms(projects).some((root) =>
    forms(file).some((candidate) => {
      const rel = path.relative(root, candidate);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
      const [, folder, name, ...deeper] = rel.split(path.sep);
      return (
        folder === 'memory' &&
        name !== undefined &&
        deeper.length === 0 &&
        markdownNotes(name) &&
        name !== fold('MEMORY.md')
      );
    }),
  );
}

/** The project a session folder's notes belong to: the one Claude named the folder for, the
 * session's start folder, else cwd or a parent; null when none matches. */
export function transcriptNotesProject(
  transcriptPath: string,
  cwd: string | null,
  machine: Pick<AdapterContext, 'platform' | 'env' | 'files' | 'projectIdentity'>,
): ProjectIdentity | null {
  const fold = (name: string) => (machine.platform === 'win32' ? name.toLowerCase() : name);
  const folder = fold(path.basename(path.dirname(transcriptPath)));
  const start = transcriptStartCwd(machine.files, transcriptPath);
  const pinned = pinnedProjectDirName(machine.env);
  if (pinned !== null && fold(pinned) === folder) {
    const from = start ?? cwd;
    return from !== null && machine.files.exists(from) ? machine.projectIdentity(from) : null;
  }
  for (const from of [start, cwd]) {
    for (
      let dir = from === null ? null : path.resolve(from);
      dir !== null;
      dir = path.dirname(dir) === dir ? null : path.dirname(dir)
    ) {
      if ([dir, machine.files.realPath(dir)].some((d) => fold(claudeFolderName(d)) === folder)) {
        return machine.files.exists(dir) ? machine.projectIdentity(dir) : null;
      }
    }
  }
  return null;
}

const START_SCAN_BYTES = 64 * 1024;

function transcriptStartCwd(files: AgentFiles, transcriptPath: string): string | null {
  const head = files.readHead(transcriptPath, START_SCAN_BYTES);
  if (head === null) return null;
  for (const line of head.split('\n')) {
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    if (cwd === undefined) continue;
    const decoded = tryParseJson(`"${cwd}"`);
    if (isJsonString(decoded)) return decoded;
  }
  return null;
}

function projectFolders(ctx: AdapterContext, config: string): string[] {
  const projects = path.join(config, 'projects');
  const names =
    ctx.projectRoot === undefined ? [] : [...claudeMemoryFolderNames(ctx, ctx.projectRoot)];
  const pinned = pinnedProjectDirName(ctx.env);
  if (pinned !== null) names.push(pinned);
  return names.map((name) => path.join(projects, name, 'memory'));
}

function pinnedProjectDirName(env: AdapterContext['env']): string | null {
  const pinned = env.CLAUDE_CODE_PROJECT_DIR_NAME;
  return env.CLAUDE_CONFIG_DIR && pinned !== undefined && PROJECT_DIR_NAME.test(pinned)
    ? pinned
    : null;
}

function userFolders(ctx: AdapterContext, config: string, warnings: string[]): string[] {
  const dir = autoMemoryDirectory(ctx, path.join(config, 'settings.json'), warnings);
  return dir === null ? [] : [dir];
}

function autoMemoryDirectory(
  ctx: AdapterContext,
  settings: string,
  warnings: string[],
): string | null {
  if (!ctx.files.exists(settings)) return null;
  const file = ctx.files.readText(settings);
  if (!file.ok) {
    warnings.push(file.reason);
    return null;
  }
  let json;
  try {
    json = parseJson(file.text);
  } catch (err) {
    log.debug(`claude-code: ${settings} not read`, errorFields(err));
    warnings.push(`${settings}: ${errorMessage(err)}`);
    return null;
  }
  const value = isJsonObjectLiteral(json) ? json.autoMemoryDirectory : undefined;
  if (!isStringValue(value) || value === '') return null;
  const dir = expandHome(value, ctx.home);
  if (path.isAbsolute(dir)) return dir;
  warnings.push(
    `${settings}: autoMemoryDirectory "${value}" is not absolute or under ~/, so it is ignored`,
  );
  return null;
}

const NOTES: FolderRules = {
  recursive: false,
  include: markdownNotes,
  item(text, mtimeMs) {
    const { yaml, body } = splitFrontmatter(text);
    if (yaml === null) return null;
    const updatedAt = itemTime(frontmatterField(yaml, 'modified'), mtimeMs);
    const title = frontmatterField(yaml, 'name');
    return title === null
      ? { text: body.trim(), updatedAt }
      : { text: body.trim(), updatedAt, title };
  },
};

function readFolders(ctx: AdapterContext, folders: readonly string[], scope: Scope): Container[] {
  return uniqueFolders(folders, ctx.platform)
    .map((dir) => readFolderStore(ctx.files, dir, scope, NOTES))
    .filter((c): c is Container => c !== null);
}
