// transcriptNotesProject walked the disk for the project; it now asks the machine, so a machine held in memory answers.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeFolderName, transcriptNotesProject } from '../../src/domain/agent-memories/claude-code.js';
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
