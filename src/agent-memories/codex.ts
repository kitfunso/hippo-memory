// Codex CLI's memory_summary.md, the one memory file Codex puts in its prompt, read as a single text-keyed file.
import fs from 'node:fs';
import path from 'node:path';
import { codexHomeDir } from '../hooks.js';
import { readTextFile } from './files.js';
import { textItemKeys } from './keys.js';
import { splitMarkdownItems } from './markdown.js';
import type { Adapter, Container, MemoryItem } from './types.js';

// "What's in Memory" only indexes MEMORY.md, so it is left out.
const KEPT_HEADINGS: ReadonlySet<string> = new Set(['user profile', 'user preferences', 'general tips']);
const PROFILE_HEADING = /^##[ \t]+User Profile[ \t]*$/im;

export const codexAdapter: Adapter = {
  tool: 'codex',
  list(ctx, scope) {
    const home = codexHomeDir(ctx.home, ctx.env);
    const containers: Container[] = [];
    if (scope === 'user') {
      const container = readSummary(path.join(home, 'memories', 'memory_summary.md'));
      if (container !== null) containers.push(container);
    }
    return { tool: 'codex', home, containers, warnings: [] };
  },
};

function readSummary(file: string): Container | null {
  if (!fs.existsSync(file)) return null;
  const read = readTextFile(file);
  if (!read.ok) return unreadable(file, read.reason);
  if (!isCodexSummary(read.text)) {
    return unreadable(file, `${file}: not a Codex memory summary (needs "v1" first and a "## User Profile" heading)`);
  }
  const kept = splitMarkdownItems(read.text)
    .filter((item) => KEPT_HEADINGS.has(item.heading.trim().toLowerCase()))
    .map((item) => ({ headingSlug: item.headingSlug, text: `${item.heading}: ${item.text}` }));
  const keys = textItemKeys(kept);
  const items: MemoryItem[] = kept.map(({ text }, i) => ({ key: keys[i], text, updatedAt: read.mtimeMs }));
  return { scope: 'user', path: file, readable: true, items, skipped: [], warnings: [], textKeyed: true };
}

function isCodexSummary(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '');
  return first?.trim() === 'v1' && PROFILE_HEADING.test(text);
}

function unreadable(file: string, warning: string): Container {
  return { scope: 'user', path: file, readable: false, items: [], skipped: [], warnings: [warning], textKeyed: true };
}
