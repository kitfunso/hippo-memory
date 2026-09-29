/**
 * OpenClaw adapter: workspace precedence and the items of the workspace's MEMORY.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../src/agent-memories/keys.js';
import { openclawAdapter } from '../src/agent-memories/openclaw.js';
import type { AdapterContext } from '../src/agent-memories/types.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lines = (...parts: string[]): string => parts.join('\n');
const at = (...parts: string[]): string => path.join(tmp, ...parts);

function write(file: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function ctxFor(env: Record<string, string | undefined> = {}, over: Partial<AdapterContext> = {}): AdapterContext {
  return { home: at('home'), env, platform: process.platform, ...over };
}

const hash12 = (text: string): string => sha256Hex(text).slice(0, 12);

describe('openclaw adapter: workspace precedence', () => {
  // Folder variables are given relative to the temp tree and resolved inside the test; the profile is used as is.
  const cases: ReadonlyArray<readonly [string, Record<string, string>, string[]]> = [
    ['nothing set', {}, ['home', '.openclaw', 'workspace']],
    ['OPENCLAW_HOME', { OPENCLAW_HOME: 'oc-home' }, ['oc-home', '.openclaw', 'workspace']],
    ['a profile', { OPENCLAW_PROFILE: 'work' }, ['home', '.openclaw-work', 'workspace']],
    [
      'a profile with OPENCLAW_HOME',
      { OPENCLAW_HOME: 'oc-home', OPENCLAW_PROFILE: 'work' },
      ['oc-home', '.openclaw-work', 'workspace'],
    ],
    ['the profile default', { OPENCLAW_PROFILE: 'default' }, ['home', '.openclaw', 'workspace']],
    ['an empty profile', { OPENCLAW_PROFILE: '' }, ['home', '.openclaw', 'workspace']],
    [
      'OPENCLAW_STATE_DIR over OPENCLAW_HOME and a profile',
      { OPENCLAW_STATE_DIR: 'state', OPENCLAW_HOME: 'oc-home', OPENCLAW_PROFILE: 'work' },
      ['state', 'workspace'],
    ],
    [
      'OPENCLAW_WORKSPACE_DIR over everything',
      {
        OPENCLAW_WORKSPACE_DIR: 'ws',
        OPENCLAW_STATE_DIR: 'state',
        OPENCLAW_HOME: 'oc-home',
        OPENCLAW_PROFILE: 'work',
      },
      ['ws'],
    ],
  ];

  it.each(cases)('%s', (_name, relEnv, expected) => {
    const env = Object.fromEntries(
      Object.entries(relEnv).map(([k, v]) => [k, k === 'OPENCLAW_PROFILE' ? v : at(v)]),
    );
    const workspace = at(...expected);
    write(path.join(workspace, 'MEMORY.md'), '- the memory that belongs to this workspace');
    // Every other candidate holds a decoy so a wrong pick shows in the items.
    for (const decoy of ['home/.openclaw', 'oc-home/.openclaw', 'state']) {
      const file = at(decoy, 'workspace', 'MEMORY.md');
      if (!fs.existsSync(file)) write(file, '- a decoy from another candidate');
    }
    const listing = openclawAdapter.list(ctxFor(env), 'user');
    expect(listing).toMatchObject({ tool: 'openclaw', home: workspace, warnings: [] });
    expect(listing.containers.map((c) => c.path)).toEqual([path.join(workspace, 'MEMORY.md')]);
    expect(listing.containers[0].items.map((i) => i.text)).toEqual(['the memory that belongs to this workspace']);
  });

  it('uses OPENCLAW_WORKSPACE_DIR as written, without ~ expansion', () => {
    const listing = openclawAdapter.list(ctxFor({ OPENCLAW_WORKSPACE_DIR: '~/ws' }), 'user');
    expect(listing.home).toBe(path.resolve('~/ws'));
    expect(listing.home).not.toBe(at('home', 'ws'));
    expect(listing.containers).toEqual([]);
  });

  it('a missing workspace gives no container and no warning', () => {
    expect(openclawAdapter.list(ctxFor(), 'user')).toMatchObject({ containers: [], warnings: [] });
  });
});

describe('openclaw adapter: MEMORY.md items', () => {
  const memoryFile = (): string => at('home', '.openclaw', 'workspace', 'MEMORY.md');

  it('stores every item as <heading>: <text>, or plain text before any heading', () => {
    const file = write(
      memoryFile(),
      lines(
        '- a bullet before any heading',
        '',
        '## Preferences',
        '- likes tabs',
        '  - even in Go',
        '',
        'A paragraph about editors.',
        '',
        '### Tools',
        '- uses pnpm',
      ),
    );
    const [container] = openclawAdapter.list(ctxFor(), 'user').containers;
    expect(container).toMatchObject({ scope: 'user', path: file, readable: true, skipped: [], warnings: [], textKeyed: true });
    expect(container.items.map((i) => i.text)).toEqual([
      'a bullet before any heading',
      'Preferences: likes tabs\n  - even in Go',
      'Preferences: A paragraph about editors.',
      'Tools: uses pnpm',
    ]);
    expect(container.items.map((i) => i.key)).toEqual([
      `top/${hash12('a bullet before any heading')}`,
      `preferences/${hash12('Preferences: likes tabs\n  - even in Go')}`,
      `preferences/${hash12('Preferences: A paragraph about editors.')}`,
      `tools/${hash12('Tools: uses pnpm')}`,
    ]);
    const mtime = fs.statSync(file).mtimeMs;
    expect(container.items.every((i) => i.updatedAt === mtime)).toBe(true);
  });

  it('a repeated bullet under one heading gets ~2', () => {
    write(memoryFile(), lines('## Notes', '- same', '- other', '- same'));
    const keys = openclawAdapter.list(ctxFor(), 'user').containers[0].items.map((i) => i.key);
    expect(keys).toEqual([
      `notes/${hash12('Notes: same')}`,
      `notes/${hash12('Notes: other')}`,
      `notes/${hash12('Notes: same')}~2`,
    ]);
  });

  it('never reads the daily notes, USER.md or DREAMS.md', () => {
    const workspace = at('home', '.openclaw', 'workspace');
    write(path.join(workspace, 'memory', '2026-09-29.md'), '- a daily note');
    write(path.join(workspace, 'USER.md'), '- a user profile line');
    write(path.join(workspace, 'DREAMS.md'), '- a dream');
    write(path.join(workspace, 'MEMORY.md'), '- the durable memory');
    const [container] = openclawAdapter.list(ctxFor(), 'user').containers;
    expect(container.items.map((i) => i.text)).toEqual(['the durable memory']);
  });

  it('gives no container when only the other workspace files exist', () => {
    const workspace = at('home', '.openclaw', 'workspace');
    write(path.join(workspace, 'memory', '2026-09-29.md'), '- a daily note');
    write(path.join(workspace, 'USER.md'), '- a user profile line');
    write(path.join(workspace, 'DREAMS.md'), '- a dream');
    expect(openclawAdapter.list(ctxFor(), 'user').containers).toEqual([]);
  });

  it('returns no container for project scope, even with a project root that holds a MEMORY.md', () => {
    write(memoryFile(), '- a user memory');
    write(at('proj', 'MEMORY.md'), '- a project file');
    const listing = openclawAdapter.list(ctxFor({}, { projectRoot: at('proj') }), 'project');
    expect(listing).toMatchObject({ tool: 'openclaw', home: at('home', '.openclaw', 'workspace'), containers: [], warnings: [] });
  });

  it.each([
    ['a NUL byte', () => Buffer.from('- a\0b\n')],
    ['a file over 256 KB', () => Buffer.from(`- ${'x'.repeat(300 * 1024)}\n`)],
  ])('%s makes the container unreadable with one warning', (_name, content) => {
    write(memoryFile(), content());
    const [container] = openclawAdapter.list(ctxFor(), 'user').containers;
    expect(container.readable).toBe(false);
    expect(container.items).toEqual([]);
    expect(container.warnings).toHaveLength(1);
    expect(container.textKeyed).toBe(true);
  });

  it('a MEMORY.md that is a folder is unreadable with one warning', () => {
    fs.mkdirSync(memoryFile(), { recursive: true });
    const [container] = openclawAdapter.list(ctxFor(), 'user').containers;
    expect(container.readable).toBe(false);
    expect(container.warnings).toHaveLength(1);
  });
});
