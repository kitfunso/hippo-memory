// transcriptNotesProject walked the disk for the project; it now asks the machine, so a machine held in memory answers.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeFolderName,
  isClaudeMemoryNote,
  transcriptNotesProject,
} from '../../src/domain/agent-memories/claude-code.js';
import type { ProjectIdentity } from '../../src/base/scope/project-identity.js';
import type { AgentFiles } from '../../src/base/util/agent-files.js';

const repo = path.resolve('/hippo-in-memory/work/acme');
const projects = path.resolve('/hippo-in-memory/claude/projects');

function memoryMachine(texts: ReadonlyMap<string, string>, folders: ReadonlySet<string>) {
  const walked: string[] = [];
  const files: AgentFiles = {
    exists: (p) => texts.has(p) || folders.has(p),
    isFolder: (p) => folders.has(p),
    folderNames: () => [],
    readHead: (file, bytes) => texts.get(file)?.slice(0, bytes) ?? null,
    readText: (file) => {
      const text = texts.get(file);
      return text === undefined ? { ok: false, reason: 'missing' } : { ok: true, text, mtimeMs: 0 };
    },
    listFiles: () => ({ status: 'missing' }),
    realPath: (p) => p,
  };
  const projectIdentity = (dir: string): ProjectIdentity => {
    walked.push(dir);
    return { root: repo, name: 'acme', legacyName: 'acme', isHome: false };
  };
  return { machine: { platform: process.platform, env: {}, files, projectIdentity }, walked };
}

describe('transcriptNotesProject on a machine held in memory', () => {
  const transcript = path.join(projects, claudeFolderName(repo), 'session.jsonl');
  const head = `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(repo)}}\n`;

  it('names the project from the in-memory transcript and asks the machine, not the disk, for it', () => {
    const { machine, walked } = memoryMachine(new Map([[transcript, head]]), new Set([repo]));
    expect(transcriptNotesProject(transcript, path.join(repo, 'src'), machine)?.name).toBe('acme');
    expect(walked).toEqual([repo]);
  });

  it('decides nothing for a start folder the machine does not hold', () => {
    const { machine, walked } = memoryMachine(new Map([[transcript, head]]), new Set());
    expect(transcriptNotesProject(transcript, null, machine)).toBeNull();
    expect(walked).toEqual([]);
  });
});

describe('isClaudeMemoryNote on a machine held in memory', () => {
  const home = path.resolve('/hippo-in-memory/home');
  const config = path.resolve('/hippo-in-memory/claude');
  const linked = path.resolve('/hippo-in-memory/linked');
  const memory = path.join(config, 'projects', 'proj-a', 'memory');

  function machineOn(
    platform: NodeJS.Platform,
    env: Record<string, string>,
    links: ReadonlyMap<string, string> = new Map(),
  ) {
    const { machine } = memoryMachine(new Map(), new Set());
    const realPath = (p: string): string => {
      const prefix = [...links.keys()].find((from) => p === from || p.startsWith(`${from}${path.sep}`));
      return prefix === undefined ? p : p.replace(prefix, links.get(prefix) ?? prefix);
    };
    return { ...machine, home, platform, env, files: { ...machine.files, realPath } };
  }

  it('takes a .md directly in a project memory folder and nothing else under the projects folder', () => {
    const m = machineOn('linux', { CLAUDE_CONFIG_DIR: config });
    expect(isClaudeMemoryNote(path.join(memory, 'queue.md'), m)).toBe(true);
    for (const other of [
      path.join(memory, 'MEMORY.md'),
      path.join(memory, 'queue.txt'),
      path.join(memory, 'sub', 'queue.md'),
      path.join(config, 'projects', 'proj-a', 'queue.md'),
      path.join(config, 'projects', 'queue.md'),
      path.join(config, 'memory', 'queue.md'),
      path.resolve('/hippo-in-memory/work/projects/proj-a/memory/queue.md'),
      memory,
    ]) {
      expect([other, isClaudeMemoryNote(other, m)]).toEqual([other, false]);
    }
  });

  it('reads CLAUDE_CONFIG_DIR, else the .claude folder in the home', () => {
    const moved = machineOn('linux', { CLAUDE_CONFIG_DIR: config });
    const unset = machineOn('linux', {});
    const homeNote = path.join(home, '.claude', 'projects', 'proj-a', 'memory', 'queue.md');
    expect(isClaudeMemoryNote(homeNote, moved)).toBe(false);
    expect(isClaudeMemoryNote(homeNote, unset)).toBe(true);
    expect(isClaudeMemoryNote(path.join(memory, 'queue.md'), unset)).toBe(false);
  });

  it('follows a link on either side to the folder it stands for', () => {
    const links = new Map([[linked, config]]);
    const viaLink = path.join(linked, 'projects', 'proj-a', 'memory', 'queue.md');
    expect(isClaudeMemoryNote(viaLink, machineOn('linux', { CLAUDE_CONFIG_DIR: config }, links))).toBe(true);
    expect(
      isClaudeMemoryNote(path.join(memory, 'queue.md'), machineOn('linux', { CLAUDE_CONFIG_DIR: linked }, links)),
    ).toBe(true);
  });

  it('folds case on win32 only, MEMORY.md included', () => {
    const upper = path.join(config.toUpperCase(), 'Projects', 'Proj-A', 'Memory');
    const win = machineOn('win32', { CLAUDE_CONFIG_DIR: config });
    expect(isClaudeMemoryNote(path.join(upper, 'Queue.md'), win)).toBe(true);
    expect(isClaudeMemoryNote(path.join(upper, 'memory.md'), win)).toBe(false);
    expect(isClaudeMemoryNote(path.join(upper, 'Queue.md'), machineOn('linux', { CLAUDE_CONFIG_DIR: config }))).toBe(
      false,
    );
    expect(isClaudeMemoryNote(path.join(memory, 'memory.md'), machineOn('linux', { CLAUDE_CONFIG_DIR: config }))).toBe(
      true,
    );
  });
});
