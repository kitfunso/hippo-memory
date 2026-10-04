// The project id: `.hippo-project.json`, then the origin remote from hand-written git config files, then the folder name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearProjectIdentityCache, projectNames, resolveProjectIdentity } from '../src/project-identity.js';
import { normaliseRemote, originUrlFromConfig } from '../src/project-remote.js';

let tmpRoot: string;
let home: string;
let savedHippoHome: string | undefined;

function mkdirs(...segments: string[]): string {
  const p = path.join(tmpRoot, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function originConfig(url: string): string {
  return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

/** A checkout whose `.git/config` names `url` as origin. */
function repo(url: string | null, ...segments: string[]): string {
  const root = mkdirs(...segments);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), url === null ? '[core]\n\tbare = false\n' : originConfig(url));
  return root;
}

const identity = (dir: string) => resolveProjectIdentity(dir, { homeDir: home });

beforeEach(() => {
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-remote-')));
  home = mkdirs('home');
  savedHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = mkdirs('global');
  clearProjectIdentityCache();
});

afterEach(() => {
  if (savedHippoHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = savedHippoHome;
  clearProjectIdentityCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('normaliseRemote', () => {
  it.each([
    ['ssh', 'ssh://git@github.com/Acme/API.git', 'github.com/acme/api'],
    ['ssh with a port', 'ssh://git@github.com:22/acme/api.git', 'github.com/acme/api'],
    ['scp', 'git@github.com:acme/api.git', 'github.com/acme/api'],
    ['scp without a user', 'github.com:acme/api', 'github.com/acme/api'],
    ['https', 'https://github.com/acme/api', 'github.com/acme/api'],
    ['https with a token and a port', 'https://oauth2:not-a-real-token@gitlab.example.com:8443/acme/api.git/', 'gitlab.example.com/acme/api'],
    ['Azure DevOps https', 'https://org@dev.azure.com/org/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['Azure DevOps ssh', 'git@ssh.dev.azure.com:v3/org/proj/repo', 'dev.azure.com/org/proj/repo'],
    ['Azure DevOps old host', 'https://org.visualstudio.com/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['Azure DevOps old host with its collection', 'https://org.visualstudio.com/DefaultCollection/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['Azure DevOps old ssh host', 'org@vs-ssh.visualstudio.com:v3/org/proj/repo', 'dev.azure.com/org/proj/repo'],
    ['https with a token in the query', 'https://gitlab.example.com/acme/api.git?private_token=not-a-real-token', 'gitlab.example.com/acme/api'],
    ['scp with a fragment', 'git@github.com:acme/api.git#main', 'github.com/acme/api'],
  ])('%s', (_form, url, id) => {
    expect(normaliseRemote(url)).toBe(id);
  });

  it.each([
    ['a file URL', 'file:///srv/git/api.git'],
    ['a file URL with a host', 'file://server/share/api.git'],
    ['an absolute path', '/srv/git/api.git'],
    ['a Windows path', 'C:\\repos\\api'],
    ['a relative path', '../api.git'],
    ['a home path', '~/git/api.git'],
    ['a remote helper', 'codecommit::us-east-1://api'],
    ['a bare host', 'https://github.com/'],
    ['nothing', '  '],
    ['an @ left in the path', 'https://github.com/acme/user:pass@api'],
  ])('names no project from %s', (_form, url) => {
    expect(normaliseRemote(url)).toBeNull();
  });
});

describe('originUrlFromConfig', () => {
  it('reads the first origin url, with quotes and comments, and ignores other remotes', () => {
    const text = '[remote "upstream"]\n\turl = git@github.com:up/api.git\n[remote "origin"] # mine\n\turl = "git@github.com:acme/api.git" ; why\n\turl = git@github.com:second/api.git\n';
    expect(originUrlFromConfig(text)).toBe('git@github.com:acme/api.git');
  });

  it('reads the old dotted section, and treats the subsection name as case-sensitive', () => {
    expect(originUrlFromConfig('[remote.origin]\nurl = https://github.com/acme/api\n')).toBe('https://github.com/acme/api');
    expect(originUrlFromConfig('[remote "Origin"]\n\turl = https://github.com/acme/api\n')).toBeNull();
  });
});

describe('resolveProjectIdentity with an origin remote', () => {
  it('names a checkout by its remote and keeps the folder rule as its legacy name', () => {
    const root = repo('git@github.com:acme/api.git', 'home', 'work', 'api');
    expect(identity(mkdirs('home', 'work', 'api', 'src'))).toEqual({ root, name: 'github.com/acme/api', legacyName: 'api', aliases: ['api'], isHome: false });
  });

  it('falls back to the folder name with no remote, and with a file remote', () => {
    expect(identity(repo(null, 'home', 'api'))).toMatchObject({ name: 'api', legacyName: 'api' });
    expect(identity(repo('file:///srv/git/tool.git', 'home', 'tool'))).toMatchObject({ name: 'tool', legacyName: 'tool' });
  });

  it('prefers the id in .hippo-project.json, lowercased, and ignores an unusable one', () => {
    const root = repo('git@github.com:acme/api.git', 'home', 'api');
    fs.writeFileSync(path.join(root, '.hippo-project.json'), JSON.stringify({ id: 'Acme-API' }));
    expect(identity(root)).toMatchObject({ name: 'acme-api', legacyName: 'api' });
    clearProjectIdentityCache();
    fs.writeFileSync(path.join(root, '.hippo-project.json'), JSON.stringify({ id: 'has a space' }));
    expect(identity(root).name).toBe('github.com/acme/api');
  });

  it('refuses a remote-shaped id in .hippo-project.json, so a clone cannot claim another project', () => {
    const root = repo(null, 'home', 'api');
    fs.writeFileSync(path.join(root, '.hippo-project.json'), JSON.stringify({ id: 'github.com/acme/billing' }));
    expect(identity(root).name).toBe('api');
  });

  it('still reads rows under every rung that resolves: the remote under a file id, and with the rule off', () => {
    const root = repo('git@github.com:acme/api.git', 'home', 'api');
    fs.writeFileSync(path.join(root, '.hippo-project.json'), JSON.stringify({ id: 'acme-api' }));
    expect(projectNames(identity(root))).toEqual(['acme-api', 'github.com/acme/api', 'api']);
    fs.rmSync(path.join(root, '.hippo-project.json'));
    fs.writeFileSync(path.join(process.env.HIPPO_HOME!, 'config.json'), JSON.stringify({ projectIdentity: { remote: false } }));
    clearProjectIdentityCache();
    expect(projectNames(identity(root))).toEqual(['api', 'github.com/acme/api']);
  });

  it('gives a linked worktree its main checkout remote, read through commondir', () => {
    repo('https://github.com/acme/api.git', 'home', 'api');
    const link = mkdirs('home', 'api', '.git', 'worktrees', 'api-wt');
    fs.writeFileSync(path.join(link, 'commondir'), '../..\n');
    const wt = mkdirs('home', 'api-wt');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${link}\n`);
    expect(identity(wt)).toMatchObject({ root: wt, name: 'github.com/acme/api', legacyName: 'api' });
  });

  it('gives a worktree of a bare repo the bare repo remote', () => {
    const bare = mkdirs('home', 'tool.git');
    fs.writeFileSync(path.join(bare, 'config'), originConfig('git@github.com:acme/tool.git'));
    const link = mkdirs('home', 'tool.git', 'worktrees', 'main');
    fs.writeFileSync(path.join(link, 'commondir'), '../..\n');
    const wt = mkdirs('home', 'tool-main');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, link)}\n`);
    expect(identity(wt)).toMatchObject({ name: 'github.com/acme/tool', legacyName: 'tool' });
  });

  it('gives a submodule its own remote from its gitdir config, not the parent repo', () => {
    repo('git@github.com:acme/app.git', 'home', 'app');
    const modules = mkdirs('home', 'app', '.git', 'modules', 'lib');
    fs.writeFileSync(path.join(modules, 'config'), originConfig('git@github.com:acme/lib.git'));
    const sub = mkdirs('home', 'app', 'lib');
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/lib\n');
    expect(identity(sub)).toMatchObject({ name: 'github.com/acme/lib', legacyName: 'lib' });
  });

  it('keeps home user-global even when home is a checkout with a remote', () => {
    fs.mkdirSync(path.join(home, '.git'));
    fs.writeFileSync(path.join(home, '.git', 'config'), originConfig('git@github.com:me/dotfiles.git'));
    expect(identity(mkdirs('home', 'notes'))).toMatchObject({ name: '', legacyName: '', isHome: true });
  });

  it('names a nested store by its own folder, since the remote names the whole checkout', () => {
    repo('git@github.com:acme/mono.git', 'home', 'mono');
    const pkg = mkdirs('home', 'mono', 'packages', 'web');
    fs.mkdirSync(path.join(pkg, '.hippo'));
    expect(identity(pkg)).toMatchObject({ name: 'web', legacyName: 'web' });
  });

  it('drops the remote rule when the global config sets projectIdentity.remote to false', () => {
    const root = repo('git@github.com:acme/api.git', 'home', 'api');
    fs.writeFileSync(path.join(process.env.HIPPO_HOME!, 'config.json'), JSON.stringify({ projectIdentity: { remote: false } }));
    clearProjectIdentityCache();
    expect(identity(root)).toMatchObject({ name: 'api', legacyName: 'api' });
    fs.writeFileSync(path.join(root, '.hippo-project.json'), JSON.stringify({ id: 'acme-api' }));
    clearProjectIdentityCache();
    expect(identity(root).name).toBe('acme-api');
  });
});
