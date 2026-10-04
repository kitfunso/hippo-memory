// Every command that imports agent memories, run through the built CLI in a scratch home (plan design 11).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeFolderName } from '../src/agent-memories/claude-code.js';
import { deriveOriginProject } from '../src/project-identity.js';
import { isInitialized } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const HIPPO_BIN = resolve(__dirname, '..', 'bin', 'hippo.js');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-agentmem-cli-')));
  dirs.push(dir);
  return dir;
}

interface Box {
  readonly home: string;
  readonly global: string;
  readonly project: string;
}

function box(): Box {
  const project = tmp();
  execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
  return { home: tmp(), global: join(tmp(), 'global'), project };
}

function env(b: Box, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...process.env, HOME: b.home, USERPROFILE: b.home, APPDATA: join(b.home, 'AppData', 'Roaming'), HIPPO_HOME: b.global, HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
  };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME', 'HIPPO_AGENT_MEMORY_TOOLS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete out[key];
  return { ...out, ...extra };
}

function hippo(b: Box, cwd: string, args: string[], opts: { extra?: Record<string, string>; input?: string } = {}): string {
  return execFileSync(process.execPath, [HIPPO_BIN, ...args], {
    cwd, env: env(b, opts.extra), input: opts.input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
  });
}

function note(dir: string, file: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\nname: ${file}\ntype: feedback\n---\n${body}\n`, 'utf8');
}

const projectNotes = (b: Box, project = b.project): string => join(b.home, '.claude', 'projects', claudeFolderName(project), 'memory');

/** Claude Code's user folder is whatever `autoMemoryDirectory` in its user settings names. */
function userNotes(b: Box): string {
  const dir = join(b.home, 'automem');
  mkdirSync(join(b.home, '.claude'), { recursive: true });
  writeFileSync(join(b.home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: dir }), 'utf8');
  return dir;
}

type MemoryEntryRow = ReturnType<typeof loadAllEntries>[number];

const imported = (root: string): string[] =>
  isInitialized(root) ? loadAllEntries(root).filter((e) => e.source?.startsWith('agent-memory:')).map((e) => e.content).sort() : [];

const PROJECT_NOTE = 'Run the schema check before this service deploys.';
const USER_NOTE = 'The user prefers short replies with the answer first.';

describe('hippo init', () => {
  it('imports the project notes into the local store and the user notes into the global store, on every run', () => {
    const b = box();
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    note(userNotes(b), 'voice.md', USER_NOTE);

    const out = hippo(b, b.project, ['init', '--no-hooks', '--no-schedule']);
    expect(out).toContain('Imported 2 agent memories (Claude Code 2).');
    expect(imported(join(b.project, '.hippo'))).toEqual([PROJECT_NOTE]);
    expect(imported(b.global)).toEqual([USER_NOTE]);

    const later = 'The staging database moved to the eu-central region.';
    note(projectNotes(b), 'staging.md', later);
    expect(hippo(b, b.project, ['init', '--no-hooks', '--no-schedule'])).toContain('Imported 1 agent memory (Claude Code 1).');
    expect(imported(join(b.project, '.hippo'))).toEqual([PROJECT_NOTE, later].sort());
  });

  it('imports nothing with --no-learn, or with the tools variable set to none', () => {
    const b = box();
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    note(userNotes(b), 'voice.md', USER_NOTE);

    hippo(b, b.project, ['init', '--no-hooks', '--no-schedule', '--no-learn']);
    hippo(b, b.project, ['init', '--no-hooks', '--no-schedule'], { extra: { HIPPO_AGENT_MEMORY_TOOLS: 'none' } });
    expect(imported(join(b.project, '.hippo'))).toEqual([]);
    expect(imported(b.global)).toEqual([]);
  });

  it('--global runs the user pass, also on a global store that already exists', () => {
    const b = box();
    hippo(b, b.project, ['init', '--global', '--no-learn']);
    note(userNotes(b), 'voice.md', USER_NOTE);

    expect(hippo(b, b.project, ['init', '--global'])).toContain('Already initialized global store');
    expect(imported(b.global)).toEqual([USER_NOTE]);
    expect(isInitialized(join(b.project, '.hippo'))).toBe(false);
  });

  it('--scan runs each repository\'s project pass, then the user pass once, in one line', () => {
    const b = box();
    const scan = tmp();
    const repos = ['alpha', 'beta'].map((name) => {
      const repo = join(scan, name);
      mkdirSync(repo);
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      note(projectNotes(b, repo), 'own.md', `The ${name} service pins its toolchain in the lockfile.`);
      return repo;
    });
    note(userNotes(b), 'voice.md', USER_NOTE);

    const out = hippo(b, scan, ['init', '--scan', scan, '--no-schedule', '--days', '1']);
    expect(out.match(/Imported \d+ agent memor/g)).toEqual(['Imported 3 agent memor']);
    expect(out).toContain('Imported 3 agent memories (Claude Code 3).');
    for (const [i, repo] of repos.entries()) {
      expect(imported(join(repo, '.hippo'))).toEqual([`The ${['alpha', 'beta'][i]} service pins its toolchain in the lockfile.`]);
    }
    expect(imported(b.global)).toEqual([USER_NOTE]);
  });
});

describe('hippo setup', () => {
  it('imports the user notes into the global store; --dry-run writes nothing', () => {
    const b = box();
    note(userNotes(b), 'voice.md', USER_NOTE);

    expect(hippo(b, b.project, ['setup', '--dry-run', '--no-schedule'])).toContain('[dry-run] Imported 1 agent memory (Claude Code 1).');
    expect(imported(b.global)).toEqual([]);

    expect(hippo(b, b.project, ['setup', '--no-schedule'])).toContain('Imported 1 agent memory (Claude Code 1).');
    expect(imported(b.global)).toEqual([USER_NOTE]);
  });
});

describe('hippo sleep', () => {
  it('imports new notes, skips them on --no-learn, and writes nothing on --dry-run', () => {
    const b = box();
    hippo(b, b.project, ['init', '--no-hooks', '--no-schedule', '--no-learn']);
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    const local = join(b.project, '.hippo');

    expect(hippo(b, b.project, ['sleep', '--dry-run'])).toContain('import --agents --dry-run');
    hippo(b, b.project, ['sleep', '--no-learn']);
    expect(imported(local)).toEqual([]);

    expect(hippo(b, b.project, ['sleep'])).toContain('Imported 1 agent memory (Claude Code 1).');
    expect(imported(local)).toEqual([PROJECT_NOTE]);
  });
});

describe('hippo import --agents', () => {
  it('--dry-run prints each tool\'s home and folders and what would change, and writes nothing', () => {
    const b = box();
    hippo(b, b.project, ['init', '--no-hooks', '--no-schedule', '--no-learn']);
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    const local = join(b.project, '.hippo');

    const dry = hippo(b, b.project, ['import', '--agents', '--dry-run']);
    expect(dry).toContain('Agent memories (dry run, nothing written):');
    expect(dry).toContain(`Claude Code: ${join(b.home, '.claude')}`);
    expect(dry).toContain('1 note');
    expect(dry).toContain('would be 1 new');
    expect(dry).toContain(`Codex: ${join(b.home, '.codex')} (no memory folders found)`);
    expect(imported(local)).toEqual([]);

    expect(hippo(b, b.project, ['import', '--agents'])).toContain('1 new');
    expect(imported(local)).toEqual([PROJECT_NOTE]);
  });

  it('in a folder without a store, imports as session end does: the project notes into the global store under its origin', () => {
    const b = box();
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    note(userNotes(b), 'voice.md', USER_NOTE);

    const dry = hippo(b, b.project, ['import', '--agents', '--dry-run']);
    expect(dry.toLowerCase()).toContain(`project ${projectNotes(b)}: 1 note`.toLowerCase());
    expect(dry).toContain('would be 2 new');
    expect(imported(b.global)).toEqual([]);

    hippo(b, b.project, ['import', '--agents']);
    const byText = new Map(loadAllEntries(b.global).filter((e) => e.source?.startsWith('agent-memory:')).map((e) => [e.content, e.origin_project]));
    expect(byText.get(PROJECT_NOTE)).toBe(deriveOriginProject(b.project));
    expect(byText.get(USER_NOTE)).toBe('');
    expect(isInitialized(join(b.project, '.hippo'))).toBe(false);
  });
});

describe('hooks in a folder without a store', () => {
  it('post-compact reads only the transcript folder, into the global store with the project as origin', () => {
    const b = box();
    hippo(b, b.project, ['init', '--global', '--no-learn']);
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    note(userNotes(b), 'voice.md', USER_NOTE);
    const sub = join(b.project, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    const session = join(b.home, '.claude', 'projects', claudeFolderName(sub));
    const transcriptNote = 'The session folder note says the queue drains at midnight.';
    note(join(session, 'memory'), 'queue.md', transcriptNote);
    const transcript = join(session, 's1.jsonl');
    writeFileSync(transcript, '', 'utf8');

    const payload = JSON.stringify({ session_id: 's1', transcript_path: transcript, cwd: sub, trigger: 'auto' });
    hippo(b, sub, ['post-compact'], { input: payload });

    const rows = loadAllEntries(b.global).filter((e) => e.source?.startsWith('agent-memory:'));
    expect(rows.map((e) => e.content)).toEqual([transcriptNote]);
    const origin = deriveOriginProject(b.project);
    expect(origin).not.toBe('');
    expect(rows[0].origin_project).toBe(origin);
  });

  it('session end imports the project and transcript notes with the project as origin, then the user pass', () => {
    const b = box();
    hippo(b, b.project, ['init', '--global', '--no-learn']);
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    note(userNotes(b), 'voice.md', USER_NOTE);
    const sub = join(b.project, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    const session = join(b.home, '.claude', 'projects', claudeFolderName(sub));
    const transcriptNote = 'The session folder note says the queue drains at midnight.';
    note(join(session, 'memory'), 'queue.md', transcriptNote);
    const transcript = join(session, 's1.jsonl');
    writeFileSync(transcript, '', 'utf8');

    hippo(b, sub, ['__session-end-worker', '--transcript', transcript, '--session-id', 's1']);

    const rows = loadAllEntries(b.global).filter((e) => e.source?.startsWith('agent-memory:'));
    const origin = deriveOriginProject(b.project);
    const byText = new Map(rows.map((e) => [e.content, e.origin_project]));
    expect([...byText.keys()].sort()).toEqual([PROJECT_NOTE, USER_NOTE, transcriptNote].sort());
    expect(byText.get(PROJECT_NOTE)).toBe(origin);
    expect(byText.get(transcriptNote)).toBe(origin);
    expect(byText.get(USER_NOTE)).toBe('');
    expect(isInitialized(join(b.project, '.hippo'))).toBe(false);
  });

  it('a worktree and its main checkout share one global row of the Claude folder they share, and a worktree that gets a store leaves it to the main checkout', () => {
    const b = box();
    const git = (cwd: string, ...args: string[]): void => { execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' }); };
    git(b.project, 'commit', '-q', '--allow-empty', '-m', 'base');
    const worktree = join(tmp(), 'feature-wt');
    git(b.project, 'worktree', 'add', '-q', worktree);
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    const [main, wt] = [deriveOriginProject(b.project), deriveOriginProject(worktree)];
    expect(wt).toBe(main);

    hippo(b, b.project, ['import', '--agents']);
    hippo(b, worktree, ['import', '--agents']);
    const origins = (): string[] => (isInitialized(b.global) ? loadAllEntries(b.global) : [])
      .filter((e) => e.content === PROJECT_NOTE).map((e) => e.origin_project ?? '').sort();
    expect(origins()).toEqual([main]);

    hippo(b, worktree, ['init', '--no-hooks', '--no-schedule']);
    expect(origins()).toEqual([main]);
    expect(imported(join(worktree, '.hippo'))).toEqual([PROJECT_NOTE]);
  });

  it('handover finds the global copies a folder with no git wrote as user-global before its store existed', () => {
    const b = box();
    const plain = tmp();
    note(projectNotes(b, plain), 'schema.md', PROJECT_NOTE);
    hippo(b, plain, ['import', '--agents']);
    const globalRows = (): MemoryEntryRow[] => (isInitialized(b.global) ? loadAllEntries(b.global) : []).filter((e) => e.content === PROJECT_NOTE);
    expect(globalRows().map((e) => e.origin_project)).toEqual(['']);

    hippo(b, plain, ['init', '--no-hooks', '--no-schedule']);
    expect(imported(join(plain, '.hippo'))).toEqual([PROJECT_NOTE]);
    expect(globalRows()).toEqual([]);
  });

  it('handover leaves the global copy of a note the new local store could not read', () => {
    const b = box();
    note(projectNotes(b), 'schema.md', PROJECT_NOTE);
    hippo(b, b.project, ['import', '--agents']);
    expect(imported(b.global)).toEqual([PROJECT_NOTE]);

    note(projectNotes(b), 'schema.md', `${PROJECT_NOTE}\n${'x'.repeat(300 * 1024)}`);
    hippo(b, b.project, ['init', '--no-hooks', '--no-schedule']);
    expect(imported(join(b.project, '.hippo'))).toEqual([]);
    expect(imported(b.global)).toEqual([PROJECT_NOTE]);
  });
});
