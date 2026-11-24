import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HIPPO_BIN } from '../_helpers/hippo-bin.js';

const PKG = '@huggingface/transformers@4.3.2';
const FAKE_NPM = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const prefix = args[args.indexOf('--prefix') + 1];
const lib = process.platform === 'win32' ? '' : 'lib';
const pkg = path.join(prefix, lib, 'node_modules', '@huggingface', 'transformers');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.js' }));
fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = {};');
console.log('added 1 package');
`;

describe('hippo init installs the local embedder from a global npm install', () => {
  let tmp: string;
  let prefix: string;
  let hippoBin: string;
  let npmLog: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embedder-'));
    prefix = path.join(tmp, 'prefix');
    const modules = path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules');
    fs.mkdirSync(path.join(modules, 'npm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(modules, 'npm', 'bin', 'npm-cli.js'), FAKE_NPM);
    const repo = path.dirname(path.dirname(HIPPO_BIN));
    fs.symlinkSync(repo, path.join(modules, 'hippo-memory'), 'junction');
    hippoBin = path.join(modules, 'hippo-memory', 'bin', 'hippo.js');
    npmLog = path.join(tmp, 'npm.log');
    fs.mkdirSync(path.join(tmp, 'proj'));
  });

  afterEach(() => {
    const link = path.dirname(path.dirname(hippoBin));
    fs.unlinkSync(link);
    if (fs.existsSync(link)) throw new Error(`could not remove the link ${link}; left ${tmp} in place`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function hippo(...args: string[]): string {
    const r = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', hippoBin, ...args], {
      cwd: path.join(tmp, 'proj'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmp,
        USERPROFILE: tmp,
        HIPPO_HOME: path.join(tmp, 'global'),
        HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
        HIPPO_SKIP_EMBEDDER_INSTALL: '',
        FAKE_NPM_LOG: npmLog,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  const npmCalls = (): string[][] => {
    if (!fs.existsSync(npmLog)) return [];
    const lines = fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean);
    // SAFETY: the fake npm writes each line as JSON.stringify of its string argv.
    return lines.map((line) => JSON.parse(line) as string[]);
  };

  it('installs into its own prefix before it makes the store, and only once', () => {
    const first = hippo('init', '--no-learn', '--no-schedule');
    expect(npmCalls()).toEqual([['install', '--global', '--prefix', prefix, '--ignore-scripts', PKG]]);
    expect(first.indexOf('Local embeddings are on.')).toBeGreaterThan(-1);
    expect(first.indexOf('Local embeddings are on.')).toBeLessThan(first.indexOf('Initialized Hippo at'));

    hippo('init', '--no-learn', '--no-schedule');
    expect(npmCalls()).toHaveLength(1);
  });

  it('skips npm with --no-embeddings, and a later init names the memories that need vectors', () => {
    hippo('init', '--no-learn', '--no-schedule', '--no-embeddings');
    expect(npmCalls()).toEqual([]);

    hippo('remember', 'the deploy script needs the staging flag');
    const later = hippo('init', '--no-learn', '--no-schedule');
    expect(npmCalls()).toHaveLength(1);
    expect(later).toContain('Run `hippo embed` to add vectors to the 1 memory stored before now.');
  });
});
