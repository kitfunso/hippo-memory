import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hermesHomeDir, type HermesHome } from '../../src/base/util/agent-homes.js';
import { hermesAdapter, hermesEntries } from '../../src/domain/agent-memories/hermes.js';
import { sha256Hex } from '../../src/domain/agent-memories/keys.js';
import type { AdapterContext } from '../../src/domain/agent-memories/types.js';
import { REAL_IO } from '../_helpers/real-io.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const at = (...parts: string[]): string => path.join(tmp, ...parts);

function write(file: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function ctxFor(env: Record<string, string | undefined> = {}, over: Partial<AdapterContext> = {}): AdapterContext {
  return { home: at('home'), env, platform: process.platform, ...REAL_IO, ...over };
}

const hash12 = (text: string): string => sha256Hex(text).slice(0, 12);

describe('hermesEntries', () => {
  it.each([
    ['LF', 'first\n§\nsecond', ['first', 'second']],
    ['CRLF, as Hermes writes a file on Windows', 'first\r\n§\r\nsecond\r\n', ['first', 'second']],
    ['a lone CR', 'first\r§\rsecond', ['first', 'second']],
    ['a BOM', '﻿first\n§\nsecond', ['first', 'second']],
    ['an empty file', '', []],
    ['only blanks', ' \n\n  \r\n', []],
    ['only delimiters', '\n§\n\n§\n', []],
    ['a § inside a line', 'likes § signs\n§\nnext', ['likes § signs', 'next']],
    ['a § on a line with other text', 'a\n§ b\n§\nc', ['a\n§ b', 'c']],
    ['padding and a multi-line entry', '  line one\nline two  \n§\nlast\n', ['line one\nline two', 'last']],
  ])('%s', (_name, raw, expected) => {
    expect(hermesEntries(raw)).toEqual(expected);
  });
});

describe('hermes adapter', () => {
  const home = (): string => at('hh');
  const memoryDir = (): string => path.join(home(), 'memories');
  const env = () => ({ HERMES_HOME: home() });

  it('gives one container for each of MEMORY.md and USER.md, the profile home as the listing home', () => {
    const memory = write(path.join(memoryDir(), 'MEMORY.md'), 'first\n§\nsecond');
    const user = write(path.join(memoryDir(), 'USER.md'), 'likes tabs');
    const listing = hermesAdapter.list(ctxFor(env()), 'user');
    expect(listing).toMatchObject({ tool: 'hermes', home: home(), warnings: [] });
    expect(listing.containers.map((c) => c.path)).toEqual([memory, user]);
    expect(listing.containers[0]).toMatchObject({
      scope: 'user',
      readable: true,
      skipped: [],
      warnings: [],
      textKeyed: true,
    });
    expect(listing.containers[0].items.map((i) => i.text)).toEqual(['first', 'second']);
    expect(listing.containers[0].items.map((i) => i.key)).toEqual([`/${hash12('first')}`, `/${hash12('second')}`]);
    expect(listing.containers[1].items.map((i) => i.text)).toEqual(['likes tabs']);
    const mtime = fs.statSync(memory).mtimeMs;
    expect(listing.containers[0].items.every((i) => i.updatedAt === mtime)).toBe(true);
  });

  it('a repeated entry in one file gets ~2', () => {
    write(path.join(memoryDir(), 'MEMORY.md'), 'same\n§\nother\n§\nsame');
    const keys = hermesAdapter.list(ctxFor(env()), 'user').containers[0].items.map((i) => i.key);
    expect(keys).toEqual([`/${hash12('same')}`, `/${hash12('other')}`, `/${hash12('same')}~2`]);
  });

  it('a missing file gives no container and no warning', () => {
    const user = write(path.join(memoryDir(), 'USER.md'), 'likes tabs');
    const listing = hermesAdapter.list(ctxFor(env()), 'user');
    expect(listing.containers.map((c) => c.path)).toEqual([user]);
    expect(listing.warnings).toEqual([]);
    expect(hermesAdapter.list(ctxFor({ HERMES_HOME: at('nowhere') }), 'user').containers).toEqual([]);
  });

  it('reads the profile active_profile names, and nothing from the folder beside it', () => {
    write(path.join(home(), 'active_profile'), '﻿Work\n');
    write(path.join(memoryDir(), 'MEMORY.md'), 'a decoy from the default profile');
    const file = write(path.join(home(), 'profiles', 'work', 'memories', 'MEMORY.md'), 'the work memory');
    const listing = hermesAdapter.list(ctxFor(env()), 'user');
    expect(listing.home).toBe(path.join(home(), 'profiles', 'work'));
    expect(listing.containers.map((c) => c.path)).toEqual([file]);
    expect(listing.containers[0].items.map((i) => i.text)).toEqual(['the work memory']);
  });

  it('never reads other files in the memories folder', () => {
    write(path.join(memoryDir(), 'MEMORY.md.lock'), 'a lock');
    write(path.join(memoryDir(), 'notes.md'), 'a note');
    write(path.join(memoryDir(), 'MEMORY.md'), 'the memory');
    const [container, ...rest] = hermesAdapter.list(ctxFor(env()), 'user').containers;
    expect(rest).toEqual([]);
    expect(container.items.map((i) => i.text)).toEqual(['the memory']);
  });

  it('returns no container for project scope, even with a project root that holds the files', () => {
    write(path.join(memoryDir(), 'MEMORY.md'), 'a user memory');
    write(at('proj', 'memories', 'MEMORY.md'), 'a project file');
    const listing = hermesAdapter.list(ctxFor(env(), { projectRoot: at('proj') }), 'project');
    expect(listing).toMatchObject({ tool: 'hermes', home: home(), containers: [], warnings: [] });
  });

  it.each([
    ['a NUL byte', () => Buffer.from('a\0b')],
    ['an empty file', () => Buffer.alloc(0)],
    ['a file over 256 KB', () => Buffer.from('x'.repeat(300 * 1024))],
  ])('%s makes that container unreadable with one warning, and the other file still reads', (_name, content) => {
    write(path.join(memoryDir(), 'MEMORY.md'), 'the memory');
    write(path.join(memoryDir(), 'USER.md'), content());
    const [memory, user] = hermesAdapter.list(ctxFor(env()), 'user').containers;
    expect(memory).toMatchObject({ readable: true });
    expect(memory.items.map((i) => i.text)).toEqual(['the memory']);
    expect(user).toMatchObject({ readable: false, items: [], skipped: [], textKeyed: true });
    expect(user.warnings).toHaveLength(1);
  });

  it('a USER.md that is a folder is unreadable with one warning', () => {
    fs.mkdirSync(path.join(memoryDir(), 'USER.md'), { recursive: true });
    const [container] = hermesAdapter.list(ctxFor(env()), 'user').containers;
    expect(container.readable).toBe(false);
    expect(container.warnings).toHaveLength(1);
  });
});

describe('hermesHomeDir', () => {
  const root = path.resolve(path.sep, 'hermes-fixture');
  const user = path.join(root, 'home');
  const nativeWin = path.join(user, 'AppData', 'Local', 'hermes');
  const nativePosix = path.join(user, '.hermes');
  const custom = path.join(root, 'custom');

  function filesOf(texts: Record<string, string>): Parameters<typeof hermesHomeDir>[3] {
    return {
      readText: (file) =>
        file in texts ? { ok: true, text: texts[file], mtimeMs: 0 } : { ok: false, reason: `${file}: missing` },
    };
  }

  const resolve = (
    env: Record<string, string>,
    platform: NodeJS.Platform,
    texts: Record<string, string> = {},
  ): HermesHome => hermesHomeDir(user, env, platform, filesOf(texts));

  it.each<readonly [string, Record<string, string>, NodeJS.Platform, string]>([
    ['unset on win32', {}, 'win32', nativeWin],
    ['unset on linux', {}, 'linux', nativePosix],
    ['unset on darwin', {}, 'darwin', nativePosix],
    ['LOCALAPPDATA set on win32', { LOCALAPPDATA: path.join(root, 'lad') }, 'win32', path.join(root, 'lad', 'hermes')],
    [
      'LOCALAPPDATA with padding on win32',
      { LOCALAPPDATA: `  ${path.join(root, 'lad')} ` },
      'win32',
      path.join(root, 'lad', 'hermes'),
    ],
    ['LOCALAPPDATA blank on win32', { LOCALAPPDATA: '  ' }, 'win32', nativeWin],
    ['LOCALAPPDATA ignored on linux', { LOCALAPPDATA: path.join(root, 'lad') }, 'linux', nativePosix],
    ['a suffix on win32', { HERMES_DATA_DIR_SUFFIX: '-dev' }, 'win32', `${nativeWin}-dev`],
    ['a suffix on linux', { HERMES_DATA_DIR_SUFFIX: '-dev' }, 'linux', `${nativePosix}-dev`],
    ['HERMES_HOME blank', { HERMES_HOME: '   ' }, 'linux', nativePosix],
  ])('%s gives the default home and no profile', (_name, env, platform, expected) => {
    expect(resolve(env, platform)).toEqual({ home: expected, profile: null });
  });

  it('expands ~ and environment references in HERMES_HOME', () => {
    expect(resolve({ HERMES_HOME: '~/hh' }, 'linux')).toEqual({ home: path.join(user, 'hh'), profile: null });
    expect(resolve({ HERMES_HOME: '~' }, 'linux')).toEqual({ home: user, profile: null });
    expect(resolve({ HERMES_HOME: '$XDG_DATA_HOME/hermes', XDG_DATA_HOME: custom }, 'linux')).toEqual({
      home: `${custom}/hermes`,
      profile: null,
    });
    expect(resolve({ HERMES_HOME: '${XDG_DATA_HOME}/hermes', XDG_DATA_HOME: '~/data' }, 'linux')).toEqual({
      home: path.join(user, 'data', 'hermes'),
      profile: null,
    });
    expect(resolve({ HERMES_HOME: '%localappdata%/hermes-alt', LOCALAPPDATA: custom }, 'win32')).toEqual({
      home: `${custom}/hermes-alt`,
      profile: null,
    });
    expect(resolve({ HERMES_HOME: '$UNSET_VAR/hermes' }, 'linux')).toEqual({
      home: '$UNSET_VAR/hermes',
      profile: null,
    });
  });

  it('HERMES_HOME at a profile folder is that profile, and no active_profile is read', () => {
    const profileHome = path.join(custom, 'profiles', 'Work');
    const texts = {
      [path.join(nativePosix, 'active_profile')]: 'decoy',
      [path.join(custom, 'active_profile')]: 'decoy',
      [path.join(profileHome, 'active_profile')]: 'decoy',
    };
    expect(resolve({ HERMES_HOME: profileHome }, 'linux', texts)).toEqual({ home: profileHome, profile: 'Work' });
    expect(resolve({ HERMES_HOME: `${profileHome}${path.sep}` }, 'linux', texts).profile).toBe('Work');
  });

  it('a profile folder under the default home is still that profile', () => {
    const profileHome = path.join(nativeWin, 'profiles', 'work');
    expect(resolve({ HERMES_HOME: profileHome }, 'win32')).toEqual({ home: profileHome, profile: 'work' });
  });

  it("HERMES_HOME at a custom root reads that root's active_profile, not the default home's", () => {
    const texts = {
      [path.join(nativePosix, 'active_profile')]: 'decoy',
      [path.join(custom, 'active_profile')]: 'work\n',
    };
    expect(resolve({ HERMES_HOME: custom }, 'linux', texts)).toEqual({
      home: path.join(custom, 'profiles', 'work'),
      profile: 'work',
    });
  });

  it('HERMES_HOME at a custom root with no active_profile is that root', () => {
    const texts = { [path.join(nativePosix, 'active_profile')]: 'decoy' };
    expect(resolve({ HERMES_HOME: custom }, 'linux', texts)).toEqual({ home: custom, profile: null });
  });

  it("HERMES_HOME inside the default home reads the default home's active_profile and keeps the profile under HERMES_HOME", () => {
    const inner = path.join(nativePosix, 'inner');
    const texts = {
      [path.join(nativePosix, 'active_profile')]: 'work',
      [path.join(inner, 'active_profile')]: 'decoy',
    };
    expect(resolve({ HERMES_HOME: inner }, 'linux', texts)).toEqual({
      home: path.join(inner, 'profiles', 'work'),
      profile: 'work',
    });
    expect(resolve({ HERMES_HOME: inner }, 'linux', { [path.join(nativePosix, 'active_profile')]: 'default' })).toEqual(
      {
        home: inner,
        profile: null,
      },
    );
  });

  it('HERMES_HOME equal to the default home is the default home', () => {
    const texts = { [path.join(nativePosix, 'active_profile')]: 'work' };
    expect(resolve({ HERMES_HOME: nativePosix }, 'linux', texts)).toEqual({
      home: path.join(nativePosix, 'profiles', 'work'),
      profile: 'work',
    });
  });

  it('a folder that only starts like the default home is a custom root', () => {
    const sibling = `${nativePosix}-other`;
    const texts = {
      [path.join(nativePosix, 'active_profile')]: 'decoy',
      [path.join(sibling, 'active_profile')]: 'work',
    };
    expect(resolve({ HERMES_HOME: sibling }, 'linux', texts).profile).toBe('work');
  });

  it('the suffix moves the default home that HERMES_HOME is compared against', () => {
    const texts = { [`${nativePosix}-dev${path.sep}active_profile`]: 'work' };
    const inner = path.join(`${nativePosix}-dev`, 'inner');
    expect(resolve({ HERMES_HOME: inner, HERMES_DATA_DIR_SUFFIX: '-dev' }, 'linux', texts).profile).toBe('work');
  });

  it.each([
    ['a BOM, a capital and a newline', '﻿Work\n', 'work'],
    ['padding', '  work  \r\n', 'work'],
    ['default', 'default\n', null],
    ['Default', 'Default', null],
    ['an empty file', '', null],
    ['blanks', ' \n', null],
    ['a name that is not a profile id', '../evil', null],
    ['a name with a separator', 'a/b', null],
  ])('active_profile holding %s', (_name, text, profile) => {
    const texts = { [path.join(nativePosix, 'active_profile')]: text };
    expect(resolve({}, 'linux', texts)).toEqual(
      profile === null
        ? { home: nativePosix, profile: null }
        : { home: path.join(nativePosix, 'profiles', profile), profile },
    );
  });

  it('an unreadable active_profile counts as no profile', () => {
    expect(resolve({}, 'win32', {})).toEqual({ home: nativeWin, profile: null });
  });

  it('reads active_profile from the default home on win32', () => {
    const texts = { [path.join(nativeWin, 'active_profile')]: 'work' };
    expect(resolve({}, 'win32', texts)).toEqual({ home: path.join(nativeWin, 'profiles', 'work'), profile: 'work' });
  });
});
