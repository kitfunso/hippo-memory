/** `hippo capture --file` through the built CLI: bullets under a spec heading become spec memories, and the refusals. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hippo-capture-cli-'));
  mkdirSync(join(cwd, 'global-hippo'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function capture(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'capture', ...args], {
    cwd,
    env: { ...process.env, HIPPO_HOME: join(cwd, 'global-hippo'), HIPPO_TENANT: 'default', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function file(name: string, text: string): string {
  const p = join(cwd, name);
  writeFileSync(p, text);
  return p;
}

const SPEC = [
  '## Requirements',
  '- the importer accepts utf-16 encoded files',
  '',
  '1. retries are capped at five attempts per batch',
  '- tiny',
  '## Background',
  '- the importer was written in a single afternoon',
].join('\n');

describe('hippo capture --file', () => {
  it('turns bullets under a spec heading into spec memories, and a second run skips them', () => {
    initStore(join(cwd, '.hippo'));
    const notes = file('notes.md', SPEC);

    const dry = capture('--file', notes, '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[capture] (spec) the importer accepts utf-16 encoded files');
    expect(dry.stdout).toContain('[capture] (spec) retries are capped at five attempts per batch');
    expect(dry.stdout).not.toContain('tiny');
    expect(dry.stdout).not.toContain('(spec) the importer was written');
    expect(loadAllEntries(join(cwd, '.hippo'))).toHaveLength(0);

    expect(capture('--file', notes).status).toBe(0);
    const specRows = loadAllEntries(join(cwd, '.hippo')).filter((e) => e.tags.includes('spec'));
    expect(specRows.map((e) => e.content).sort()).toEqual([
      'retries are capped at five attempts per batch',
      'the importer accepts utf-16 encoded files',
    ]);

    const again = capture('--file', notes, '--dry-run');
    expect(again.stdout).toContain('[skip] (spec) the importer accepts utf-16 encoded files');
    expect(again.stdout).not.toContain('[capture] (spec)');
  });

  it('refuses a missing file with exit 1', () => {
    initStore(join(cwd, '.hippo'));
    const r = capture('--file', join(cwd, 'nope.md'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('File not found');
  });

  it('says there is nothing to capture from an empty file and writes nothing', () => {
    initStore(join(cwd, '.hippo'));
    const r = capture('--file', file('empty.md', '   \n'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No text to capture from.');
    expect(loadAllEntries(join(cwd, '.hippo'))).toHaveLength(0);
  });

  it('refuses to run without a store and tells the user to run hippo init', () => {
    const r = capture('--file', file('notes.md', SPEC));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No hippo store at .*Run `hippo init` first/);
  });
});
