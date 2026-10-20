// Gemini CLI: the "Gemini Added Memories" section of GEMINI.md, and the auto-memory folder that projects.json names.
import path from 'node:path';
import { isStringValue } from '../../base/session/capture-contract.js';
import type { AgentFiles } from '../../base/util/agent-files.js';
import { splitFrontmatter } from './files.js';
import { markdownNotes, readFolderStore, type FolderRules } from './folder-store.js';
import { gitLayout } from './git.js';
import { textItemKeys } from './keys.js';
import { splitMarkdownItems } from './markdown.js';
import type { Adapter, AdapterContext, Container, Listing, Scope } from './types.js';
import { type JsonValue, isJsonObjectLiteral, parseJson, type JsonObject } from '../../base/util/json.js';
import { errorMessage } from '../../base/util/log.js';

const SECTION = 'gemini added memories';

export const geminiAdapter: Adapter = {
  tool: 'gemini',
  list(ctx, scope) {
    const home = path.join(ctx.env.GEMINI_CLI_HOME || ctx.home, '.gemini');
    if (scope === 'user') return { tool: 'gemini', home, containers: userContainers(ctx.files, home), warnings: [] };
    return projectListing(ctx, home);
  },
};

function refused(scope: Scope, file: string, reason: string, textKeyed: boolean): Container {
  return { scope, path: file, readable: false, items: [], skipped: [], warnings: [reason], textKeyed };
}

function userContainers(files: AgentFiles, home: string): Container[] {
  const file = path.join(home, 'GEMINI.md');
  if (!files.exists(file)) return [];
  const read = files.readText(file);
  if (!read.ok) return [refused('user', file, read.reason, true)];
  const kept = splitMarkdownItems(read.text).filter((item) => item.heading.toLowerCase() === SECTION);
  const keys = textItemKeys(kept);
  const items = kept.map((item, i) => ({ key: keys[i], text: item.text, updatedAt: read.mtimeMs }));
  return [{ scope: 'user', path: file, readable: true, items, skipped: [], warnings: [], textKeyed: true }];
}

function projectListing(ctx: AdapterContext, home: string): Listing {
  const warnings: string[] = [];
  const containers: Container[] = [];
  if (ctx.projectRoot !== undefined) {
    const slug = projectSlug(ctx, ctx.projectRoot, home, warnings);
    const container =
      slug === null ? null : readFolderStore(ctx.files, path.join(home, 'tmp', slug, 'memory'), 'project', NOTES);
    if (container !== null) containers.push(container);
  }
  return { tool: 'gemini', home, containers, warnings };
}

function projectSlug(ctx: AdapterContext, projectRoot: string, home: string, warnings: string[]): string | null {
  const index = path.join(home, 'projects.json');
  if (!ctx.files.exists(index)) return null;
  const read = ctx.files.readText(index);
  if (!read.ok) {
    warnings.push(read.reason);
    return null;
  }
  let projects: JsonObject;
  try {
    projects = parseIndex(read.text);
  } catch (err) {
    warnings.push(`${index}: ${errorMessage(err)}`);
    return null;
  }
  // The git top level is only asked for when the folder itself has no entry, since it spawns git.
  const entry = findEntry(projects, projectRoot, ctx.platform) ?? topEntry(ctx, projects, projectRoot);
  if (entry === undefined) return null;
  const [key, slug] = entry;
  if (isStringValue(slug) && isPlainName(slug)) return slug;
  warnings.push(`${index}: the slug for ${key} is not a plain folder name`);
  return null;
}

function parseIndex(text: string): JsonObject {
  const data = parseJson(text);
  const projects = isJsonObjectLiteral(data) ? data.projects : undefined;
  if (!isJsonObjectLiteral(projects)) throw new Error('expected { "projects": { "<absolute path>": "<slug>" } }');
  return projects;
}

function isPlainName(slug: string): boolean {
  return slug !== '' && slug !== '.' && slug !== '..' && !/[\\/]/.test(slug);
}

function fold(p: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// A relative key would resolve against the working folder, which no adapter may read.
function findEntry(projects: JsonObject, target: string, platform: NodeJS.Platform): [string, JsonValue] | undefined {
  const want = fold(target, platform);
  return Object.entries(projects).find(([key]) => path.isAbsolute(key) && fold(key, platform) === want);
}

function topEntry(ctx: AdapterContext, projects: JsonObject, projectRoot: string): [string, JsonValue] | undefined {
  const top = gitLayout(ctx.git, projectRoot)?.top;
  return top === undefined ? undefined : findEntry(projects, top, ctx.platform);
}

const NOTES: FolderRules = {
  recursive: false,
  include: markdownNotes,
  item: (text, mtimeMs) => ({ text: splitFrontmatter(text).body.trim(), updatedAt: mtimeMs }),
};
