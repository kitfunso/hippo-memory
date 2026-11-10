// Round 4 prereg item 11: the pins check stops a launch or regrade on any pinned file, folder or hippo build that moved.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { MANIFEST, manifestText, runCli } from '../scripts/token-eval/z0-pins-check.mjs';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

type Pins = Record<string, string | undefined>;
let work: string;
let checkout: string;
const roles = () => ['seam=seam.sh', 'tree:tasks=tasks'];
const lines = (r: { stderr: string }) => r.stderr.split('\n').filter((l) => l !== '');
const check = (...extra: string[]) => runCli(['--pins', 'pins.json', '--checkout', checkout, ...roles(), ...extra], work);
const write = (...extra: string[]) => runCli(['--write', 'pins.json', '--checkout', checkout, '--set', 'model=claude-sonnet-5-5', '--set', 'effort=medium', ...extra, ...roles()], work);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-pins-'));
  checkout = path.join(work, 'hippo');
  // The real repo's .gitignore drops dist/, so a changed build file leaves `git status` clean.
  put(checkout, '.gitignore', 'dist/\n');
  put(checkout, 'dist/a.js', 'a');
  put(checkout, 'dist/sub/b.js', 'b');
  put(checkout, 'src.ts', 's');
  git(checkout, 'init', '-q');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'build');
  put(work, 'seam.sh', '#!/bin/sh\n');
  put(work, 'tasks/k/tasks-run.json', '{}');
  put(work, 'tasks/top.txt', 'top');
  expect(runCli(['--manifest', 'tasks'], work).code).toBe(0);
  expect(write().code).toBe(0);
});

describe('--pins', () => {
  it('passes with exit 0 and names the build when every file, folder and the hippo build are as pinned', () => {
    const r = check();
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toMatch(/^pins ok: 2 files and folders, hippo build [0-9a-f]{40}\n$/);
  });

  it('exits 3 with a PINS line when a pinned file changes by one byte', () => {
    put(work, 'seam.sh', '#!/bin/sh \n');
    const r = check();
    expect(r.code).toBe(3);
    expect(lines(r)).toEqual([expect.stringMatching(/^PINS: seam is pinned [0-9a-f]{64}, this file has [0-9a-f]{64}$/)]);
  });

  it('exits 3 when the pins file lacks a role\'s key, naming the key', () => {
    const pins = JSON.parse(fs.readFileSync(path.join(work, 'pins.json'), 'utf8'));
    delete pins['sha256:seam'];
    put(work, 'pins.json', JSON.stringify(pins));
    expect(lines(check())).toEqual(['PINS: seam: pins.json has no key sha256:seam']);
  });

  it('exits 3 when the pins file lacks hippoCommit', () => {
    const pins = JSON.parse(fs.readFileSync(path.join(work, 'pins.json'), 'utf8'));
    delete pins.hippoCommit;
    put(work, 'pins.json', JSON.stringify(pins));
    expect(lines(check())).toEqual(['PINS: hippoCommit is not pinned']);
  });

  it('exits 3 naming each pinned role that the call does not check, with none given and with one of the two', () => {
    const none = runCli(['--pins', 'pins.json', '--checkout', checkout], work);
    expect([none.code, none.stdout, lines(none)]).toEqual([3, '', ['PINS: seam is pinned but not checked; pass seam=<path>', 'PINS: tasks is pinned but not checked; pass tasks=<path>']]);
    const one = runCli(['--pins', 'pins.json', '--checkout', checkout, 'seam=seam.sh'], work);
    expect([one.code, lines(one)]).toEqual([3, ['PINS: tasks is pinned but not checked; pass tasks=<path>']]);
    const other = runCli(['--pins', 'pins.json', '--checkout', checkout, 'tree:tasks=tasks'], work);
    expect([other.code, lines(other)]).toEqual([3, ['PINS: seam is pinned but not checked; pass seam=<path>']]);
  });

  it('exits 3 on a file that does not exist, naming the role', () => {
    fs.rmSync(path.join(work, 'seam.sh'));
    const r = check();
    expect(r.code).toBe(3);
    expect(lines(r)).toEqual([expect.stringMatching(/^PINS: seam: .*seam\.sh does not exist$/)]);
  });

  it('exits 3 on a dirty checkout', () => {
    put(checkout, 'src.ts', 'changed');
    expect(lines(check())).toEqual([expect.stringMatching(/^PINS: the hippo checkout .* has changes beyond its commit/)]);
    git(checkout, 'checkout', '-q', '--', 'src.ts');
    expect(check().code).toBe(0);
  });

  it('exits 3 on a changed file under an ignored dist/ while git stays clean, and only the dist hash line fires', () => {
    expect(git(checkout, 'ls-files', 'dist')).toBe('');
    put(checkout, 'dist/sub/b.js', 'B');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    const r = check();
    expect(r.code).toBe(3);
    expect(lines(r)).toEqual([expect.stringMatching(/^PINS: hippoDistHash is pinned [0-9a-f]{64}, this run has [0-9a-f]{64}$/)]);
  });

  it('exits 3 on another HEAD, naming the pinned and the current commit', () => {
    const pinned = git(checkout, 'rev-parse', 'HEAD').trim();
    put(checkout, 'src.ts', 'next');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'next');
    const r = check();
    expect(r.code).toBe(3);
    expect(lines(r)).toEqual([`PINS: hippoCommit is pinned ${pinned}, this run has ${git(checkout, 'rev-parse', 'HEAD').trim()}`]);
  });

  it('exits 1 with the usage on a missing mode, a missing checkout, an unknown flag, a doubled flag and a bad role', () => {
    for (const argv of [[], ['--pins', 'pins.json'], ['--pins', 'pins.json', '--checkout', checkout, '--nope', 'x'], ['--pins', 'pins.json', '--pins', 'pins.json', '--checkout', checkout], ['--pins', 'pins.json', '--checkout', checkout, 'noequals']]) {
      const r = runCli(argv, work);
      expect([r.code, r.stdout], argv.join(' ')).toEqual([1, '']);
      expect(r.stderr).toMatch(/\n?(usage|exit 0 pass)|needs|given twice|a role is/);
    }
  });
});

describe('the tree role', () => {
  it('writes the manifest as "<sha256>  <path>" lines in path order, without itself', () => {
    const text = fs.readFileSync(path.join(work, 'tasks', MANIFEST), 'utf8');
    expect(text).toBe(`${sha(path.join(work, 'tasks/k/tasks-run.json'))}  k/tasks-run.json\n${sha(path.join(work, 'tasks/top.txt'))}  top.txt\n`);
    expect(manifestText(path.join(work, 'tasks'))).toBe(text);
  });

  it('exits 3 naming the file for a changed, a missing and an unlisted file', () => {
    put(work, 'tasks/top.txt', 'TOP');
    expect(lines(check())).toEqual(['PINS: tasks: top.txt changed']);
    fs.rmSync(path.join(work, 'tasks/k/tasks-run.json'));
    expect(lines(check())).toEqual(['PINS: tasks: k/tasks-run.json is missing', 'PINS: tasks: top.txt changed']);
    put(work, 'tasks/extra.txt', 'x');
    expect(lines(check())).toContain(`PINS: tasks: extra.txt is not in ${MANIFEST}`);
    expect(check().code).toBe(3);
  });

  it('exits 3 on a folder with no manifest and on a malformed manifest line, and pins the manifest\'s own hash', () => {
    const pins = JSON.parse(fs.readFileSync(path.join(work, 'pins.json'), 'utf8'));
    expect(pins['sha256:tasks']).toBe(sha(path.join(work, 'tasks', MANIFEST)));
    fs.writeFileSync(path.join(work, 'tasks', MANIFEST), 'garbage\n');
    expect(lines(check())).toContain(`PINS: tasks: ${MANIFEST} line 1 is not "<sha256>  <path>"`);
    fs.rmSync(path.join(work, 'tasks', MANIFEST));
    expect(lines(check())).toEqual([expect.stringMatching(/^PINS: tasks: .*sha256\.txt does not exist; write it with --manifest$/)]);
  });

  it('exits 3 naming a link under the folder, in --manifest and in the check', () => {
    // A directory junction needs no privilege on Windows, where a file symlink does.
    put(work, 'outside/x.txt', 'x');
    const link = path.join(work, 'tasks', 'k', 'lnk');
    fs.symlinkSync(path.join(work, 'outside'), link, 'junction');
    const manifest = fs.readFileSync(path.join(work, 'tasks', MANIFEST), 'utf8');
    for (const r of [runCli(['--manifest', 'tasks'], work), check()]) {
      expect(r.code).toBe(3);
      expect(lines(r)).toEqual([`PINS: ${link} is a link; a pinned folder holds files only`]);
    }
    expect(fs.readFileSync(path.join(work, 'tasks', MANIFEST), 'utf8')).toBe(manifest);
  });

  it('refuses --write on a folder that differs from its manifest', () => {
    put(work, 'tasks/top.txt', 'TOP');
    const r = write();
    expect([r.code, lines(r)]).toEqual([3, ['PINS: tasks: top.txt changed']]);
  });
});

describe('--write', () => {
  it('writes three passing files that differ only in effort, each ending in a newline', () => {
    const [base, low, high] = ['pins.json', 'pins-effort-low.json', 'pins-effort-high.json'].map((f) => JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')));
    expect([base.effort, low.effort, high.effort]).toEqual(['medium', 'low', 'high']);
    const noEffort = (o: Pins) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'effort'));
    expect([noEffort(low), noEffort(high)]).toEqual([noEffort(base), noEffort(base)]);
    expect(base).toMatchObject({ model: 'claude-sonnet-5-5', hippoCommit: git(checkout, 'rev-parse', 'HEAD').trim(), 'sha256:seam': sha(path.join(work, 'seam.sh')) });
    for (const f of ['pins.json', 'pins-effort-low.json', 'pins-effort-high.json']) {
      expect(fs.readFileSync(path.join(work, f), 'utf8').endsWith('}\n'), f).toBe(true);
      expect(runCli(['--pins', f, '--checkout', checkout, ...roles()], work).code, f).toBe(0);
    }
  });

  it('exits 1, naming the role, on a role given twice, and writes nothing', () => {
    const before = fs.readFileSync(path.join(work, 'pins.json'), 'utf8');
    for (const extra of [['seam=seam.sh'], ['tree:seam=tasks']]) {
      const r = write(...extra);
      expect([r.code, r.stdout], extra.join(' ')).toEqual([1, '']);
      expect(r.stderr).toMatch(/^role seam is given twice; a role names one file or folder\n/);
    }
    expect(fs.readFileSync(path.join(work, 'pins.json'), 'utf8')).toBe(before);
    const checked = check('seam=seam.sh');
    expect([checked.code, checked.stderr]).toEqual([1, expect.stringMatching(/^role seam is given twice/)]);
  });

  it('exits 1, naming the key, on --set of a sha256: key, and writes nothing', () => {
    const before = fs.readFileSync(path.join(work, 'pins.json'), 'utf8');
    const r = write('--set', `sha256:seam=${'0'.repeat(64)}`);
    expect([r.code, r.stdout]).toEqual([1, '']);
    expect(r.stderr).toMatch(/^--set sha256:seam: a sha256: key is written from its <role>=<path> argument/);
    expect(fs.readFileSync(path.join(work, 'pins.json'), 'utf8')).toBe(before);
  });

  it('exits 1, naming the key, on a --set of a build key, a key given twice or no effort, and writes nothing', () => {
    const written = () => fs.readdirSync(work).filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(work, f), 'utf8')]);
    const before = written();
    const bare = (...sets: string[]) => runCli(['--write', 'pins.json', '--checkout', checkout, ...sets.flatMap((s) => ['--set', s]), ...roles()], work);
    const cases: [string, { code: number; stdout: string; stderr: string }, RegExp][] = [
      ['hippoCommit', write('--set', 'hippoCommit=abc'), /^--set hippoCommit: the build computes it from --checkout/],
      ['hippoDistHash', write('--set', 'hippoDistHash=abc'), /^--set hippoDistHash: the build computes it from --checkout/],
      ['a repeated key', write('--set', 'model=other'), /^--set model is given twice; each key takes one value\n$/],
      ['a repeated effort', write('--set', 'effort=high'), /^--set effort is given twice; each key takes one value\n$/],
      ['no effort', bare('model=claude-sonnet-5-5'), /^--write needs --set effort=<value>/],
      ['an empty effort', bare('effort='), /^--write needs --set effort=<value>/],
    ];
    for (const [what, r, message] of cases) {
      expect([r.code, r.stdout], what).toEqual([1, '']);
      expect(r.stderr, what).toMatch(message);
    }
    expect(written()).toEqual(before);
  });

  it('names the effort files after the pins file, so two pins files in one folder keep their own', () => {
    put(work, 'other.txt', 'other');
    const own = ['other=other.txt'];
    const r = runCli(['--write', 'p2.json', '--checkout', checkout, '--set', 'effort=medium', ...own], work);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').filter((l) => l !== '').map((l) => path.basename(l))).toEqual(['p2.json', 'p2-effort-low.json', 'p2-effort-high.json']);
    expect(fs.readdirSync(work).filter((f) => f.includes('-effort-')).sort()).toEqual(['p2-effort-high.json', 'p2-effort-low.json', 'pins-effort-high.json', 'pins-effort-low.json']);
    for (const [stem, roleArgs] of [['pins', roles()], ['p2', own]] as const) {
      for (const effort of ['low', 'high']) {
        const f = `${stem}-effort-${effort}.json`;
        expect(JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')).effort, f).toBe(effort);
        expect(runCli(['--pins', f, '--checkout', checkout, ...roleArgs], work).code, f).toBe(0);
      }
    }
  });

  it('lists the three files it wrote and exits 1 on a bad --set pair', () => {
    const r = write();
    const out = r.stdout.split('\n').filter((l) => l !== '');
    expect(out.every((l) => l.startsWith('wrote '))).toBe(true);
    expect(out.map((l) => path.basename(l))).toEqual(['pins.json', 'pins-effort-low.json', 'pins-effort-high.json']);
    const bad = runCli(['--write', 'pins.json', '--checkout', checkout, '--set', 'novalue'], work);
    expect([bad.code, bad.stderr]).toEqual([1, '--set novalue: a pair is key=value\n']);
  });
});
