// Round 4 prereg item 11: the pins check stops a launch or regrade on any pinned file, folder or hippo build that moved.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MANIFEST, manifestText, runCli } from '../scripts/token-eval/z0-pins-check.mjs';
import { testGit } from './fixtures/test-git.js';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const git = (dir: string, ...args: string[]) => testGit(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args);

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

  it('exits 1 naming the three efforts on an effort outside them, and writes nothing', () => {
    const snapshot = () => fs.readdirSync(work).sort().map((f) => [f, fs.statSync(path.join(work, f)).isFile() ? fs.readFileSync(path.join(work, f), 'utf8') : null]);
    const before = snapshot();
    const r = runCli(['--write', 'pins.json', '--checkout', checkout, '--set', 'effort=meduim', ...roles()], work);
    expect([r.code, r.stdout, r.stderr]).toEqual([1, '', '--set effort=meduim: effort is one of low, medium, high\n']);
    expect(snapshot()).toEqual(before);
  });
});

// The plan's Pins roles contract (:77): the 20 roles in `<root>/pin-roles.txt` order.
const ROLE_ORDER = ['tree:tasks', 'tree:pilot-tasks', 'tree:whole-plan', 'pip-constraint', 'prices', 'spend-basis', 'pre-levels', 'r3-inputs', 'drift-inputs', 'r3-grading', 'r3-drop-list',
  's4-run.ps1', 's4-regrade.ps1', 's4-batch.sh', 's4-units.sh', 's4-procs.ps1', 's4-read.sh', 's4-drive.sh', 'box-check.sh', 's3x-env.ps1'];
const twenty = () => ROLE_ORDER.map((r) => `${r}=roles/${r.replace(/^tree:/, '')}`);

describe('--roles', () => {
  const pinArgs = ['--pins', 'pins20.json', '--checkout'];
  const byArgs = () => runCli([...pinArgs, checkout, ...twenty()], work);
  const byFile = (file: string, extra: string[] = []) => runCli([...pinArgs, checkout, '--roles', file, ...extra], work);

  beforeEach(() => {
    for (const r of ROLE_ORDER) {
      const name = r.replace(/^tree:/, '');
      put(work, r.startsWith('tree:') ? `roles/${name}/f.txt` : `roles/${name}`, name);
      if (r.startsWith('tree:')) expect(runCli(['--manifest', `roles/${name}`], work).code).toBe(0);
    }
    expect(runCli(['--write', 'pins20.json', '--checkout', checkout, '--set', 'effort=medium', ...twenty()], work).code).toBe(0);
    put(work, 'pin-roles.txt', `${twenty().join('\n')}\n`);
  });

  it('gives the same exit, stdout and stderr as the same 20 arguments, on a pass and on two moved files', () => {
    const passed = byArgs();
    expect([passed.code, passed.stderr]).toEqual([0, '']);
    expect(passed.stdout).toMatch(/^pins ok: 20 files and folders, hippo build [0-9a-f]{40}\n$/);
    expect(byFile('pin-roles.txt')).toEqual(passed);
    const pinnedPrices = JSON.parse(fs.readFileSync(path.join(work, 'pins20.json'), 'utf8'))['sha256:prices'];
    put(work, 'roles/prices', 'moved');
    put(work, 'roles/pilot-tasks/f.txt', 'moved');
    const moved = byArgs();
    expect(moved.code).toBe(3);
    expect(lines(moved)).toEqual(['PINS: pilot-tasks: f.txt changed', `PINS: prices is pinned ${pinnedPrices}, this file has ${sha(path.join(work, 'roles/prices'))}`]);
    expect(byFile('pin-roles.txt')).toEqual(moved);
  });

  it('reads the file beside role arguments, and a role in both exits 1', () => {
    put(work, 'pin-roles-19.txt', `${twenty().slice(0, -1).join('\n')}\n`);
    expect(byFile('pin-roles-19.txt', [twenty().at(-1)!])).toEqual(byArgs());
    const twice = byFile('pin-roles-19.txt', [twenty()[0]!]);
    expect([twice.code, twice.stdout]).toEqual([1, '']);
    expect(twice.stderr).toMatch(/^role tasks is given twice; a role names one file or folder\n/);
  });

  it('exits 3 naming the role when a line is dropped from the file', () => {
    put(work, 'pin-roles-19.txt', `${twenty().slice(0, -1).join('\n')}\n`);
    const r = byFile('pin-roles-19.txt');
    expect([r.code, r.stdout, lines(r)]).toEqual([3, '', ['PINS: s3x-env.ps1 is pinned but not checked; pass s3x-env.ps1=<path>']]);
  });

  it('allows a file with no final newline, and exits 1 naming the line that holds a CR, and on a missing file', () => {
    put(work, 'pin-roles-bare.txt', twenty().join('\n'));
    expect(byFile('pin-roles-bare.txt')).toEqual(byArgs());
    put(work, 'pin-roles-cr.txt', `${twenty().map((l, i) => (i === 2 ? `${l}\r` : l)).join('\n')}\n`);
    const cr = byFile('pin-roles-cr.txt');
    expect([cr.code, cr.stdout]).toEqual([1, '']);
    expect(cr.stderr).toMatch(/^--roles pin-roles-cr\.txt: line 3 holds a carriage return; the file takes LF line ends\n/);
    const missing = byFile('no-such-roles.txt');
    expect([missing.code, missing.stdout]).toEqual([1, '']);
    expect(missing.stderr).toMatch(/no-such-roles\.txt/);
  });

  it('exits 1 naming the file and the line on a blank line inside the file, a second trailing newline and a line with no "="', () => {
    const body = twenty();
    const cases: [string, string, string][] = [
      ['a blank line inside', `${[...body.slice(0, 4), '', ...body.slice(4)].join('\n')}\n`, '--roles pin-roles-bad.txt: line 5 is blank'],
      ['a second trailing newline', `${body.join('\n')}\n\n`, '--roles pin-roles-bad.txt: line 21 is blank'],
      ['a line with no "="', `${body.map((l, i) => (i === 6 ? 'pre-levels' : l)).join('\n')}\n`, '--roles pin-roles-bad.txt: line 7 is not [tree:]<role>=<path>'],
      ['a line with no path', `${body.map((l, i) => (i === 1 ? 'tree:pilot-tasks=' : l)).join('\n')}\n`, '--roles pin-roles-bad.txt: line 2 is not [tree:]<role>=<path>'],
    ];
    for (const [what, text, message] of cases) {
      put(work, 'pin-roles-bad.txt', text);
      const r = byFile('pin-roles-bad.txt');
      expect([r.code, r.stdout], what).toEqual([1, '']);
      expect(r.stderr.split('\n')[0], what).toBe(message);
    }
  });

  it('strips a leading UTF-8 BOM, so the first role reads as it would on the command line', () => {
    put(work, 'pin-roles-bom.txt', `﻿${twenty().join('\n')}\n`);
    expect(byFile('pin-roles-bom.txt')).toEqual(byArgs());
  });
});

describe('--poetry', () => {
  const stub = (out: string) => ({ poetryLine: vi.fn(() => out) });
  const pinFile = 'pins-poetry.json';
  const written = (deps: ReturnType<typeof stub>, ...set: string[]) => runCli(['--write', pinFile, '--checkout', checkout, '--set', 'effort=medium', ...set, '--poetry', 'poetry-dir', ...roles()], work, deps);
  const checked = (deps?: ReturnType<typeof stub>, ...extra: string[]) => runCli(['--pins', pinFile, '--checkout', checkout, ...extra, ...roles()], work, deps);
  const poetryDir = () => path.join(work, 'poetry-dir');

  beforeEach(() => {
    expect(written(stub('Poetry (version 2.5.1)\n')).code).toBe(0);
  });

  it('passes when the first line names the pinned version, reading the folder resolved against the cwd', () => {
    const deps = stub('Poetry (version 2.5.1)\n');
    const r = checked(deps, '--poetry', 'poetry-dir');
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(deps.poetryLine).toHaveBeenCalledExactlyOnceWith(poetryDir());
  });

  it('exits 3 with the mismatch line when the version differs', () => {
    const r = checked(stub('Poetry (version 2.5.2)\n'), '--poetry', 'poetry-dir');
    expect([r.code, r.stdout, lines(r)]).toEqual([3, '', ['PINS: poetryVersion is pinned 2.5.1, this run has 2.5.2']]);
  });

  it('exits 3 when a pinned poetryVersion has no --poetry beside it, and runs no reader', () => {
    const deps = stub('Poetry (version 2.5.1)\n');
    const r = checked(deps);
    expect([r.code, lines(r)]).toEqual([3, ['PINS: poetryVersion is pinned but not checked; pass --poetry <dir>']]);
    expect(deps.poetryLine).not.toHaveBeenCalled();
  });

  it('exits 3 when --poetry meets a pins file with no poetryVersion', () => {
    const r = runCli(['--pins', 'pins.json', '--checkout', checkout, '--poetry', 'poetry-dir', ...roles()], work, stub('Poetry (version 2.5.1)\n'));
    expect([r.code, lines(r)]).toEqual([3, ['PINS: poetryVersion is not pinned']]);
  });

  it('writes poetryVersion into the main file and both effort files, each of which then passes', () => {
    for (const f of ['pins-r4.json', 'pins-r4-effort-low.json', 'pins-r4-effort-high.json']) expect(fs.existsSync(path.join(work, f)), f).toBe(false);
    const r = runCli(['--write', 'pins-r4.json', '--checkout', checkout, '--set', 'effort=medium', '--poetry', 'poetry-dir', ...roles()], work, stub('Poetry (version 2.5.1)\n'));
    expect(r.code).toBe(0);
    for (const f of ['pins-r4.json', 'pins-r4-effort-low.json', 'pins-r4-effort-high.json']) {
      expect(JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')).poetryVersion, f).toBe('2.5.1');
      expect(runCli(['--pins', f, '--checkout', checkout, '--poetry', 'poetry-dir', ...roles()], work, stub('Poetry (version 2.5.1)\n')).code, f).toBe(0);
    }
  });

  it('writes no poetryVersion without --poetry', () => {
    expect(JSON.parse(fs.readFileSync(path.join(work, 'pins.json'), 'utf8'))).not.toHaveProperty('poetryVersion');
  });

  it('exits 1 on --set poetryVersion and writes nothing', () => {
    const before = fs.readFileSync(path.join(work, pinFile), 'utf8');
    const r = written(stub('Poetry (version 2.5.1)\n'), '--set', 'poetryVersion=2.5.1');
    expect([r.code, r.stdout]).toEqual([1, '']);
    expect(r.stderr).toMatch(/^--set poetryVersion: --poetry writes it from the poetry folder, so --set cannot name it\n$/);
    expect(fs.readFileSync(path.join(work, pinFile), 'utf8')).toBe(before);
  });

  it('exits 3 with one PINS line naming the folder and what it printed, on a first line of another shape, in --pins and in --write', () => {
    const wrong = stub('Poetry 2.5.1\nPoetry (version 2.5.1)\n');
    for (const r of [checked(wrong, '--poetry', 'poetry-dir'), written(wrong)]) {
      expect(r.code).toBe(3);
      expect(lines(r)).toEqual([`PINS: poetryVersion: ${poetryDir()} printed "Poetry 2.5.1", not "Poetry (version <v>)"`]);
    }
  });

  it('exits 3 with one PINS line naming the folder when the reader fails, and with the real reader on a folder with no poetry.exe', () => {
    const exe = path.join(poetryDir(), 'Scripts', 'poetry.exe');
    const failing = { poetryLine: vi.fn((): string => { throw new Error('spawn failed\nmore'); }) };
    const r = checked(failing, '--poetry', 'poetry-dir');
    expect([r.code, lines(r)]).toEqual([3, [`PINS: poetryVersion: ${exe} did not run: spawn failed`]]);
    const real = checked(undefined, '--poetry', 'poetry-dir');
    expect(real.code).toBe(3);
    expect(lines(real)).toEqual([expect.stringContaining(`PINS: poetryVersion: ${exe} did not run: `)]);
  });

  it('keeps the first line of the failed run\'s stderr in the PINS line, whether it is a string or a Buffer', () => {
    const exe = path.join(poetryDir(), 'Scripts', 'poetry.exe');
    for (const stderr of ['No module named poetry\nTraceback', Buffer.from('No module named poetry\nTraceback')]) {
      const failing = { poetryLine: vi.fn((): string => { throw Object.assign(new Error('Command failed: poetry.exe --version\nNo module named poetry'), { stderr }); }) };
      const r = checked(failing, '--poetry', 'poetry-dir');
      expect([r.code, lines(r)]).toEqual([3, [`PINS: poetryVersion: ${exe} did not run: Command failed: poetry.exe --version (stderr: No module named poetry)`]]);
    }
  });

  it('gives the real reader a 30 s timeout and reads a timeout as a failed run', () => {
    const exe = path.join(poetryDir(), 'Scripts', 'poetry.exe');
    // The ESM namespace of a builtin is not configurable, so the spy sits on the CJS object and the sync copies it over.
    const spawned = vi.spyOn(childProcess, 'execFileSync').mockImplementationOnce(() => { throw Object.assign(new Error(`spawnSync ${exe} ETIMEDOUT`), { code: 'ETIMEDOUT' }); });
    syncBuiltinESMExports();
    try {
      const r = checked(undefined, '--poetry', 'poetry-dir');
      expect([r.code, lines(r)]).toEqual([3, [`PINS: poetryVersion: ${exe} did not run: spawnSync ${exe} ETIMEDOUT`]]);
      expect(spawned).toHaveBeenNthCalledWith(1, exe, ['--version'], expect.objectContaining({ timeout: 30_000 }));
    } finally {
      spawned.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe('--manifest-check', () => {
  const elsewhere = () => path.parse(work).root;
  const tasks = () => path.join(work, 'tasks');

  it('passes from the cwd the folder is relative to and from another cwd with an absolute path, naming the folder and its file count', () => {
    const [near, far] = [runCli(['--manifest-check', 'tasks'], work), runCli(['--manifest-check', tasks()], elsewhere())];
    for (const r of [near, far]) expect([r.code, r.stdout, r.stderr]).toEqual([0, `manifest ok: 2 files in ${tasks()}\n`, '']);
  });

  it('exits 3 naming the changed file from both cwds', () => {
    put(work, 'tasks/top.txt', 'TOP');
    for (const [dir, cwd] of [['tasks', work], [tasks(), elsewhere()]] as const) {
      const r = runCli(['--manifest-check', dir], cwd);
      expect([r.code, r.stdout, lines(r)]).toEqual([3, '', [`PINS: ${tasks()}: top.txt changed`]]);
    }
  });

  it('exits 3 on a missing file, an unlisted file and a missing manifest', () => {
    put(work, 'tasks/extra.txt', 'x');
    fs.rmSync(path.join(work, 'tasks/k/tasks-run.json'));
    expect(lines(runCli(['--manifest-check', 'tasks'], work))).toEqual([`PINS: ${tasks()}: k/tasks-run.json is missing`, `PINS: ${tasks()}: extra.txt is not in ${MANIFEST}`]);
    fs.rmSync(path.join(work, 'tasks', MANIFEST));
    const r = runCli(['--manifest-check', 'tasks'], work);
    expect([r.code, lines(r)]).toEqual([3, [expect.stringMatching(/^PINS: .*tasks: .*sha256\.txt does not exist; write it with --manifest$/)]]);
  });

  it('exits 3 naming a link under the folder', () => {
    put(work, 'outside/x.txt', 'x');
    const link = path.join(work, 'tasks', 'k', 'lnk');
    fs.symlinkSync(path.join(work, 'outside'), link, 'junction');
    const r = runCli(['--manifest-check', 'tasks'], work);
    expect([r.code, lines(r)]).toEqual([3, [`PINS: ${link} is a link; a pinned folder holds files only`]]);
  });

  it('exits 1 with one line naming the input, beside a role argument, --roles, --poetry, --set or --checkout, and leaves --manifest as it was', () => {
    const beside: [string[], string][] = [
      [['seam=seam.sh'], 'role argument seam=seam.sh'], [['--roles', 'pin-roles.txt'], '--roles'], [['--poetry', 'poetry-dir'], '--poetry'],
      [['--set', 'effort=medium'], '--set'], [['--checkout', checkout], '--checkout'],
    ];
    for (const [extra, name] of beside) {
      const r = runCli(['--manifest-check', 'tasks', ...extra], work);
      expect([r.code, r.stdout, lines(r)], name).toEqual([1, '', [`--manifest-check cannot be given with ${name}; it checks one folder against its own manifest`]]);
    }
    expect(runCli(['--manifest', 'tasks', '--checkout', checkout], work).code).toBe(0);
  });

  it('exits 1 on a folder that does not exist, saying so, from both cwds', () => {
    for (const [dir, cwd] of [['nowhere', work], [path.join(work, 'nowhere'), elsewhere()]] as const) {
      const r = runCli(['--manifest-check', dir], cwd);
      expect([r.code, r.stdout, r.stderr]).toEqual([1, '', `${path.join(work, 'nowhere')} does not exist\n`]);
    }
  });

  it('is one of four modes: it exits 1 beside another mode and names all four', () => {
    const r = runCli(['--manifest-check', 'tasks', '--manifest', 'tasks'], work);
    expect([r.code, r.stdout]).toEqual([1, '']);
    expect(r.stderr).toMatch(/^give exactly one of --pins, --write, --manifest and --manifest-check\n/);
  });
});
