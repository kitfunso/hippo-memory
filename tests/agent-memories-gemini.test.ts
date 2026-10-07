/**
 * Gemini CLI adapter: GEMINI.md's Added Memories section (user) and the projects.json-routed memory folder (project).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiAdapter } from '../src/agent-memories/gemini.js';
import { textItemKeys } from '../src/agent-memories/keys.js';
import type { AdapterContext } from '../src/agent-memories/types.js';
import type { JsonObject } from '../src/working-memory.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lines = (...parts: string[]): string => parts.join('\n');

function write(file: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function ctxFor(over: Partial<AdapterContext> = {}): AdapterContext {
  return { home: tmp, env: {}, platform: process.platform, ...over };
}

const geminiDir = (): string => path.join(tmp, '.gemini');
const memoryDir = (slug: string): string => path.join(geminiDir(), 'tmp', slug, 'memory');

function index(projects: JsonObject): void {
  write(path.join(geminiDir(), 'projects.json'), JSON.stringify({ projects }));
}

function makeRepo(): string {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  expect(init.status).toBe(0);
  return repo;
}

describe('gemini adapter: home', () => {
  it('uses <home>/.gemini by default', () => {
    write(path.join(geminiDir(), 'GEMINI.md'), lines('## Gemini Added Memories', '- likes tabs'));
    const listing = geminiAdapter.list(ctxFor(), 'user');
    expect(listing.tool).toBe('gemini');
    expect(listing.home).toBe(geminiDir());
    expect(listing.containers.map((c) => c.path)).toEqual([path.join(geminiDir(), 'GEMINI.md')]);
  });

  it('GEMINI_CLI_HOME replaces the home and the default folder is not read', () => {
    const other = path.join(tmp, 'elsewhere');
    write(path.join(other, '.gemini', 'GEMINI.md'), lines('## Gemini Added Memories', '- from the variable'));
    write(path.join(geminiDir(), 'GEMINI.md'), lines('## Gemini Added Memories', '- from the default'));
    const listing = geminiAdapter.list(ctxFor({ env: { GEMINI_CLI_HOME: other } }), 'user');
    expect(listing.home).toBe(path.join(other, '.gemini'));
    expect(listing.containers[0].items.map((i) => i.text)).toEqual(['from the variable']);
  });

  it('an empty GEMINI_CLI_HOME is ignored', () => {
    const listing = geminiAdapter.list(ctxFor({ env: { GEMINI_CLI_HOME: '' } }), 'user');
    expect(listing.home).toBe(geminiDir());
  });

  it('a missing folder gives no container and no warning in either scope', () => {
    const c = ctxFor({ projectRoot: path.join(tmp, 'proj') });
    expect(geminiAdapter.list(c, 'user')).toMatchObject({ containers: [], warnings: [] });
    expect(geminiAdapter.list(c, 'project')).toMatchObject({ containers: [], warnings: [] });
  });
});

describe('gemini adapter: user scope', () => {
  it('reads only the bullets of the Added Memories section, among hand-written sections', () => {
    const file = write(
      path.join(geminiDir(), 'GEMINI.md'),
      lines(
        '# My rules',
        '- always run the tests',
        '',
        '##  gemini ADDED memories  ',
        '- likes tabs',
        '- uses pnpm for installs',
        '  - not npm',
        '',
        '## Style',
        '- hand-written bullet',
        'A hand-written paragraph.',
      ),
    );
    const stat = fs.statSync(file);
    const [container] = geminiAdapter.list(ctxFor(), 'user').containers;
    expect(container).toMatchObject({
      scope: 'user',
      path: file,
      readable: true,
      skipped: [],
      warnings: [],
      textKeyed: true,
    });
    expect(container.items.map((i) => i.text)).toEqual(['likes tabs', 'uses pnpm for installs\n  - not npm']);
    expect(container.items.map((i) => i.key)).toEqual(
      textItemKeys([
        { headingSlug: 'gemini-added-memories', text: 'likes tabs' },
        { headingSlug: 'gemini-added-memories', text: 'uses pnpm for installs\n  - not npm' },
      ]),
    );
    expect(container.items[0].key).toMatch(/^gemini-added-memories\/[0-9a-f]{12}$/);
    expect(container.items.every((i) => i.updatedAt === stat.mtimeMs)).toBe(true);
  });

  it('a file without the section is readable with zero items', () => {
    write(path.join(geminiDir(), 'GEMINI.md'), lines('# Rules', '- be terse'));
    const [container] = geminiAdapter.list(ctxFor(), 'user').containers;
    expect(container).toMatchObject({ readable: true, items: [], warnings: [], textKeyed: true });
  });

  it('a repeated bullet under the section gets ~2', () => {
    write(path.join(geminiDir(), 'GEMINI.md'), lines('## Gemini Added Memories', '- same note', '- other note', '- same note'));
    const [container] = geminiAdapter.list(ctxFor(), 'user').containers;
    const keys = container.items.map((i) => i.key);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(`${keys[0]}~2`);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ['a NUL byte', () => Buffer.from('## Gemini Added Memories\n- a\0b\n')],
    ['a file over 256 KB', () => Buffer.from(`## Gemini Added Memories\n- ${'x'.repeat(300 * 1024)}\n`)],
  ])('%s makes the container unreadable with one warning', (_name, content) => {
    write(path.join(geminiDir(), 'GEMINI.md'), content());
    const [container] = geminiAdapter.list(ctxFor(), 'user').containers;
    expect(container.readable).toBe(false);
    expect(container.items).toEqual([]);
    expect(container.warnings).toHaveLength(1);
  });

  it('never returns a project container', () => {
    write(path.join(memoryDir('proj'), 'note.md'), 'a project note');
    index({ [path.join(tmp, 'proj')]: 'proj' });
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'user');
    expect(listing.containers).toEqual([]);
  });
});

describe('gemini adapter: project scope', () => {
  it('finds the folder by the project root and reads its notes', () => {
    const root = path.join(tmp, 'proj');
    index({ [root]: 'proj-slug' });
    const dir = memoryDir('proj-slug');
    const withFm = write(path.join(dir, 'a.md'), lines('---', 'name: A', '---', '', 'body of a  ', ''));
    write(path.join(dir, 'b.md'), '  plain body of b\n');
    write(path.join(dir, 'MEMORY.md'), '- index line that is never an item');
    write(path.join(dir, 'notes.txt'), 'not markdown');
    write(path.join(dir, '.hidden.md'), 'dot entry');
    write(path.join(dir, 'skills', 'inner.md'), 'inside skills');
    const listing = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project');
    expect(listing).toMatchObject({ tool: 'gemini', home: geminiDir(), warnings: [] });
    expect(listing.containers).toHaveLength(1);
    const [container] = listing.containers;
    expect(container).toMatchObject({
      scope: 'project',
      path: dir,
      readable: true,
      skipped: [],
      warnings: [],
      textKeyed: false,
    });
    expect(container.items.map(({ key, text }) => ({ key, text }))).toEqual([
      { key: 'a.md', text: 'body of a' },
      { key: 'b.md', text: 'plain body of b' },
    ]);
    expect(container.items[0].updatedAt).toBe(fs.statSync(withFm).mtimeMs);
  });

  it('finds the folder by the git top level when the root is a subfolder', () => {
    const repo = makeRepo();
    index({ [fs.realpathSync.native(repo)]: 'repo-slug' });
    write(path.join(memoryDir('repo-slug'), 'a.md'), 'note from the repository memory');
    const root = path.join(repo, 'packages', 'app');
    const [container] = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project').containers;
    expect(container.path).toBe(memoryDir('repo-slug'));
    expect(container.items.map((i) => i.key)).toEqual(['a.md']);
  });

  it('prefers the entry for the project root over the git top level', () => {
    const repo = makeRepo();
    const root = path.join(repo, 'packages', 'app');
    index({ [fs.realpathSync.native(repo)]: 'top-slug', [root]: 'root-slug' });
    write(path.join(memoryDir('top-slug'), 'a.md'), 'the top level note');
    write(path.join(memoryDir('root-slug'), 'a.md'), 'the root note');
    const [container] = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project').containers;
    expect(container.path).toBe(memoryDir('root-slug'));
  });

  it('no matching entry gives no container and no warning', () => {
    index({ [path.join(tmp, 'other')]: 'other-slug' });
    write(path.join(memoryDir('other-slug'), 'a.md'), 'not ours');
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });

  it('a matched slug whose folder is missing gives no container and no warning', () => {
    index({ [path.join(tmp, 'proj')]: 'never-written' });
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'project');
    expect(listing).toMatchObject({ containers: [], warnings: [] });
  });

  it('a missing projects.json gives no container and no warning', () => {
    write(path.join(memoryDir('proj'), 'a.md'), 'a note nobody points at');
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'project');
    expect(listing).toMatchObject({ containers: [], warnings: [] });
  });

  it('with no projectRoot there is no container and projects.json is not needed', () => {
    write(path.join(geminiDir(), 'projects.json'), '{ not json');
    const listing = geminiAdapter.list(ctxFor(), 'project');
    expect(listing).toMatchObject({ containers: [], warnings: [] });
  });

  it('malformed JSON is one listing warning and no container', () => {
    write(path.join(geminiDir(), 'projects.json'), '{ "projects": { "oops": ');
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toHaveLength(1);
  });

  it.each([
    ['an array', '[]'],
    ['no projects key', '{"other": {}}'],
    ['projects as an array', '{"projects": []}'],
    ['projects as a string', '{"projects": "x"}'],
  ])('a wrong shape (%s) is one listing warning and no container', (_name, json) => {
    write(path.join(geminiDir(), 'projects.json'), json);
    const listing = geminiAdapter.list(ctxFor({ projectRoot: path.join(tmp, 'proj') }), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toHaveLength(1);
  });

  it.each([['../escape'], ['a/b'], ['a\\b'], ['.'], ['..'], [''], [42]])(
    'the slug %j is refused with one warning and nothing outside the tmp folder is read',
    (slug) => {
      const root = path.join(tmp, 'proj');
      index({ [root]: slug });
      write(path.join(geminiDir(), 'escape', 'memory', 'a.md'), 'outside the tmp folder');
      write(path.join(geminiDir(), 'tmp', 'memory', 'a.md'), 'directly under tmp');
      const listing = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project');
      expect(listing.containers).toEqual([]);
      expect(listing.warnings).toHaveLength(1);
    },
  );

  it('a refused file lands in skipped with a warning, and the others are still read', () => {
    const root = path.join(tmp, 'proj');
    index({ [root]: 'proj' });
    const dir = memoryDir('proj');
    write(path.join(dir, 'good.md'), 'a good note');
    write(path.join(dir, 'binary.md'), Buffer.from('bad\0bytes'));
    write(path.join(dir, 'huge.md'), 'x'.repeat(300 * 1024));
    const [container] = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project').containers;
    expect(container.readable).toBe(true);
    expect(container.items.map((i) => i.key)).toEqual(['good.md']);
    expect(container.skipped).toEqual(['binary.md', 'huge.md']);
    expect(container.warnings).toHaveLength(2);
  });

  it('a memory path that is a file makes the container unreadable with one warning', () => {
    const root = path.join(tmp, 'proj');
    index({ [root]: 'proj' });
    write(memoryDir('proj'), 'not a folder');
    const [container] = geminiAdapter.list(ctxFor({ projectRoot: root }), 'project').containers;
    expect(container).toMatchObject({ readable: false, items: [], textKeyed: false });
    expect(container.warnings).toHaveLength(1);
  });

  it('compares paths case-insensitively only when ctx.platform is win32', () => {
    const root = path.join(tmp, 'proj');
    index({ [root.toUpperCase()]: 'proj' });
    write(path.join(memoryDir('proj'), 'a.md'), 'a note');
    const win = geminiAdapter.list(ctxFor({ projectRoot: root, platform: 'win32' }), 'project');
    expect(win.containers).toHaveLength(1);
    const linux = geminiAdapter.list(ctxFor({ projectRoot: root, platform: 'linux' }), 'project');
    expect(linux.containers).toEqual([]);
  });
});
