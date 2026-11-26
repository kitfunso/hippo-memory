import path from 'node:path';
import type { AgentFiles } from '../../base/util/agent-files.js';
import { hermesHomeDir } from '../../base/util/agent-homes.js';
import { textItemKeys } from './keys.js';
import type { Adapter, Container } from './types.js';

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_FILES = ['MEMORY.md', 'USER.md'] as const;

export function hermesEntries(raw: string): string[] {
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export const hermesAdapter: Adapter = {
  tool: 'hermes',
  list(ctx, scope) {
    const { home } = hermesHomeDir(ctx.home, ctx.env, ctx.platform, ctx.files);
    const containers =
      scope === 'user' ? userContainers(ctx.files, path.join(home, 'memories')) : [];
    return { tool: 'hermes', home, containers, warnings: [] };
  },
};

function userContainers(files: AgentFiles, folder: string): Container[] {
  return MEMORY_FILES.map((name) => path.join(folder, name))
    .filter((file) => files.exists(file))
    .map((file) => fileContainer(files, file));
}

function fileContainer(files: AgentFiles, file: string): Container {
  const read = files.readText(file);
  if (!read.ok) {
    return {
      scope: 'user',
      path: file,
      readable: false,
      items: [],
      skipped: [],
      warnings: [read.reason],
      textKeyed: true,
    };
  }
  const stored = hermesEntries(read.text).map((text) => ({ headingSlug: '', text }));
  const keys = textItemKeys(stored);
  const items = stored.map(({ text }, i) => ({ key: keys[i], text, updatedAt: read.mtimeMs }));
  return {
    scope: 'user',
    path: file,
    readable: true,
    items,
    skipped: [],
    warnings: [],
    textKeyed: true,
  };
}
