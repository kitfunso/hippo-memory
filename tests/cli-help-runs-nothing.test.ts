/** `hippo <verb> --help` prints usage and runs nothing, for every verb the dispatch table holds. */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMMANDS, parseArgs, usageText, verbUsage } from '../src/cli.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');
// Read from the dispatch table so a verb added later is covered without editing this file.
const VERBS = Object.entries(COMMANDS).flatMap(([verb, spec]) => [verb, ...('aliases' in spec ? spec.aliases : [])]);
// No PATH, so a verb that ignored --help could not reach schtasks, crontab or codex.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));

function runHelp(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'hippo-help-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'hippo-help-home-'));
  const hippoHome = mkdtempSync(join(tmpdir(), 'hippo-help-store-'));
  const dirs = [cwd, home, hippoHome];
  try {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...ENV, HOME: home, USERPROFILE: home, HIPPO_HOME: hippoHome, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const written = dirs.flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)));
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, written };
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

describe('built CLI: --help never runs the command', () => {
  it.each(VERBS)('hippo %s --help prints its usage and runs nothing', (verb) => {
    const res = runHelp([verb, '--help']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.written).toEqual([]);
    expect(res.stdout.trim()).toBe((verbUsage(verb) ?? usageText()).trim());
  });

  it.each(['', 'help', '--help', '-h'])('hippo %s prints the full usage and runs nothing', (form) => {
    const res = runHelp(form ? [form] : []);
    expect(res.status, res.stderr).toBe(0);
    expect(res.written).toEqual([]);
    expect(res.stdout.trim()).toBe(usageText().trim());
  });

  it('hippo init -h prints the init block and installs nothing', () => {
    const res = runHelp(['init', '-h']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.written).toEqual([]);
    expect(res.stdout.trim()).toBe(verbUsage('init')?.trim());
  });

  it.each([
    ['audit prune', '--older-than'],
    ['slack backfill', '--channel'],
    ['slack workspaces add', '--tenant'],
    ['github backfill', '--repo'],
  ])('hippo %s --help prints its own usage and runs nothing', (sub, flag) => {
    const res = runHelp([...sub.split(' '), '--help']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.written).toEqual([]);
    expect(res.stdout).toContain(flag);
  });
});

describe('usage blocks', () => {
  it('every verb but the internal __ workers has its own block', () => {
    expect(VERBS.filter((verb) => !verb.startsWith('__') && verbUsage(verb) === null)).toEqual([]);
  });

  it('a block holds only its verb, and an alias prints its verb block', () => {
    expect(verbUsage('init')).toMatch(/^ {2}init .*\n {4}--scan/);
    expect(verbUsage('init')).not.toContain('remember');
    expect(verbUsage('project-brief')).toBe(verbUsage('brief'));
    expect(verbUsage('customer-note')).toBe(verbUsage('note'));
  });
});

describe('parseArgs: -h', () => {
  const argv = (...rest: string[]) => ['node', 'hippo', ...rest];

  it('a bare -h after the verb is the help flag', () => {
    const { flags, args } = parseArgs(argv('init', '-h'));
    expect(flags['help']).toBe(true);
    expect(args).toEqual([]);
  });

  it('-h after -- or as a flag value stays literal', () => {
    const passthrough = parseArgs(argv('codex-run', '--', '-h'));
    expect(passthrough.args).toEqual(['-h']);
    expect(passthrough.flags).toEqual({});
    expect(parseArgs(argv('remember', 'x', '--tag', '-h')).flags['tag']).toEqual(['-h']);
  });
});
