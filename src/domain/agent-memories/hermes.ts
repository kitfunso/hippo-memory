import path from 'node:path';
import type { AgentFiles } from '../../base/util/agent-files.js';
import { hermesHomeDir } from '../../base/util/agent-homes.js';
import { errorMessage } from '../../base/util/log.js';
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

function emptyContainer(file: string): Container {
  return {
    scope: 'user',
    path: file,
    readable: true,
    items: [],
    skipped: [],
    warnings: [],
    textKeyed: true,
  };
}

function unreadableContainer(file: string, warning: string): Container {
  return {
    scope: 'user',
    path: file,
    readable: false,
    items: [],
    skipped: [],
    warnings: [warning],
    textKeyed: true,
  };
}

function userContainers(files: AgentFiles, folder: string): Container[] {
  const dir = files.listFiles(folder, { recursive: false });
  if (dir.status === 'missing') return [];
  if (dir.status === 'unreadable') return [unreadableContainer(folder, dir.reason)];
  return MEMORY_FILES.map((name) => memoryContainer(files, path.join(folder, name)));
}

function memoryContainer(files: AgentFiles, file: string): Container {
  if (files.exists(file)) return fileContainer(files, file);
  try {
    const head = files.readHead(file, 1);
    if (head === null) return emptyContainer(file);
    return fileContainer(files, file);
  } catch (err) {
    return unreadableContainer(file, `${file}: ${errorMessage(err)}`);
  }
}

function fileContainer(files: AgentFiles, file: string): Container {
  const read = files.readText(file);
  if (!read.ok) {
    if (read.reason === `${file}: empty`) return emptyContainer(file);
    return unreadableContainer(file, read.reason);
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
