// A malformed legacy mirror or a non-string package.json script must read as empty, never break the open.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageScriptsAt } from '../../src/domain/learn/churn-git.js';
import { onHandle, openStore } from '../../src/store/sqlite/handles.js';
import { processGit } from '../../src/base/util/git-runner.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-shapes-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('legacy index.json and stats.json shapes', () => {
  it.each(['null', '[]', '"text"', '7'])('opens a store whose index.json holds %s, twice', (body) => {
    const root = path.join(dir, '.hippo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.json'), body, 'utf8');
    fs.writeFileSync(path.join(root, 'stats.json'), body, 'utf8');
    // SAFETY: COUNT(*) always returns one row with the aliased integer column n.
    const memoryCount = (): number =>
      onHandle(root, (db) => (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, openStore);
    expect(memoryCount()).toBe(0);
    expect(memoryCount()).toBe(0);
    expect(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).toBe(body);
  });
});

describe('packageScriptsAt', () => {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = (pkg: string): string => {
    fs.writeFileSync(path.join(dir, 'package.json'), pkg, 'utf8');
    git('add', 'package.json');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
    return git('rev-parse', 'HEAD').trim();
  };

  it('returns the scripts when every value is a string', () => {
    git('init', '-q');
    expect(packageScriptsAt({ root: dir, git: processGit }, commit('{"scripts":{"a":"b"}}'))).toEqual({ a: 'b' });
  });

  it.each(['{"scripts":"build"}', '{"scripts":["x"]}', '{"scripts":{"a":1}}', '{"scripts":null}'])(
    'reads %s as no scripts',
    (pkg) => {
      git('init', '-q');
      expect(packageScriptsAt({ root: dir, git: processGit }, commit(pkg))).toEqual({});
    },
  );
});
