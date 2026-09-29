// OpenClaw keeps its durable memory in one MEMORY.md; the daily notes, USER.md and DREAMS.md are left out on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { readTextFile } from './files.js';
import { textItemKeys } from './keys.js';
import { splitMarkdownItems } from './markdown.js';
import type { Adapter, AdapterContext, Container } from './types.js';

export const openclawAdapter: Adapter = {
  tool: 'openclaw',
  list(ctx, scope) {
    const home = workspaceDir(ctx);
    return { tool: 'openclaw', home, containers: scope === 'user' ? userContainers(home) : [], warnings: [] };
  },
};

// SHORTCUT: agents.defaults.workspace in openclaw.json is not read (JSON5, no parser here); read it if users ask.
function workspaceDir(ctx: AdapterContext): string {
  const { OPENCLAW_WORKSPACE_DIR: workspace } = ctx.env;
  return path.resolve(workspace || path.join(stateDir(ctx), 'workspace'));
}

function stateDir(ctx: AdapterContext): string {
  const { OPENCLAW_STATE_DIR: state, OPENCLAW_HOME: openclawHome, OPENCLAW_PROFILE: profile } = ctx.env;
  if (state) return state;
  const suffix = profile && profile !== 'default' ? `-${profile}` : '';
  return path.join(openclawHome || ctx.home, `.openclaw${suffix}`);
}

function userContainers(workspace: string): Container[] {
  const file = path.join(workspace, 'MEMORY.md');
  if (!fs.existsSync(file)) return [];
  const read = readTextFile(file);
  if (!read.ok) {
    return [{ scope: 'user', path: file, readable: false, items: [], skipped: [], warnings: [read.reason], textKeyed: true }];
  }
  const stored = splitMarkdownItems(read.text).map(({ heading, headingSlug, text }) => ({
    headingSlug,
    text: heading === '' ? text : `${heading}: ${text}`,
  }));
  const keys = textItemKeys(stored);
  const items = stored.map(({ text }, i) => ({ key: keys[i], text, updatedAt: read.mtimeMs }));
  return [{ scope: 'user', path: file, readable: true, items, skipped: [], warnings: [], textKeyed: true }];
}
