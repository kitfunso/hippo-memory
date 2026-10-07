// Qwen Code's auto memory: markdown notes under its base folder, or inside the project when it keeps them local.
import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './files.js';
import { markdownNotes, readFolderStore, type FolderRules } from './folder-store.js';
import type { Adapter, AdapterContext, Listing } from './types.js';

/** Qwen's own folder-name rule, so a project's container is the folder Qwen made for it. */
export function sanitizeCwd(p: string, platform: NodeJS.Platform): string {
  return (platform === 'win32' ? p.toLowerCase() : p).replace(/[^a-zA-Z0-9]/g, '-');
}

function baseDir(ctx: AdapterContext): string {
  const { env } = ctx;
  return env.QWEN_CODE_MEMORY_BASE_DIR || env.QWEN_RUNTIME_DIR || env.QWEN_HOME || path.join(ctx.home, '.qwen');
}

/** The nearest folder at or above `start` holding a `.git` entry; a file counts, so a linked worktree keeps its own. */
function gitRoot(start: string): string | null {
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function projectDir(ctx: AdapterContext, base: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  if (ctx.env.QWEN_CODE_MEMORY_LOCAL === '1') return path.join(root, '.qwen', 'memory');
  const key = ctx.env.QWEN_CODE_MEMORY_PROJECT_SCOPE === 'workspace' ? root : (gitRoot(root) ?? root);
  return path.join(base, 'projects', sanitizeCwd(key, ctx.platform), 'memory');
}

const NOTES: FolderRules = {
  recursive: true,
  include: markdownNotes,
  item: (text, mtimeMs) => ({ text: splitFrontmatter(text).body.trim(), updatedAt: mtimeMs }),
};

export const qwenCodeAdapter: Adapter = {
  tool: 'qwen-code',
  list(ctx, scope): Listing {
    const base = baseDir(ctx);
    let dir: string | null = null;
    if (scope === 'user') dir = path.join(base, 'memories');
    else if (ctx.projectRoot !== undefined) dir = projectDir(ctx, base, ctx.projectRoot);
    const container = dir === null ? null : readFolderStore(dir, scope, NOTES);
    return { tool: 'qwen-code', home: base, containers: container ? [container] : [], warnings: [] };
  },
};
