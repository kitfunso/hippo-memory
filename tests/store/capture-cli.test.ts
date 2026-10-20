/** `hippo capture --file` through the CLI entry: bullets under a spec heading become spec memories, and the refusals. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const savedCwd = process.cwd();
let cwd: string;
beforeEach(() => {
  cwd = makeRoot('capture-cli', { init: false });
  mkdirSync(join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_HOME', join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
});

// A verb that sets process.exitCode instead of exiting reports it here, as the real process would on exit.
async function runVerb(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    return { status: r.status || Number(process.exitCode ?? 0), stdout: r.stdout, stderr: r.stderr };
  } finally {
    process.exitCode = undefined;
  }
}

const capture = (...args: string[]) => runVerb('capture', ...args);

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
  it('turns bullets under a spec heading into spec memories, and a second run skips them', async () => {
    initTestStore(join(cwd, '.hippo'));
    const notes = file('notes.md', SPEC);

    const dry = await capture('--file', notes, '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[capture] (spec) the importer accepts utf-16 encoded files');
    expect(dry.stdout).toContain('[capture] (spec) retries are capped at five attempts per batch');
    expect(dry.stdout).not.toContain('tiny');
    expect(dry.stdout).not.toContain('(spec) the importer was written');
    expect(loadEveryTenantEntries(join(cwd, '.hippo'))).toHaveLength(0);

    expect((await capture('--file', notes)).status).toBe(0);
    const specRows = loadEveryTenantEntries(join(cwd, '.hippo')).filter((e) => e.tags.includes('spec'));
    expect(specRows.map((e) => e.content).sort()).toEqual([
      'retries are capped at five attempts per batch',
      'the importer accepts utf-16 encoded files',
    ]);

    const again = await capture('--file', notes, '--dry-run');
    expect(again.stdout).toContain('[skip] (spec) the importer accepts utf-16 encoded files');
    expect(again.stdout).not.toContain('[capture] (spec)');
  });

  it('refuses a missing file with exit 1', async () => {
    initTestStore(join(cwd, '.hippo'));
    const r = await capture('--file', join(cwd, 'nope.md'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('File not found');
  });

  it('says there is nothing to capture from an empty file and writes nothing', async () => {
    initTestStore(join(cwd, '.hippo'));
    const r = await capture('--file', file('empty.md', '   \n'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No text to capture from.');
    expect(loadEveryTenantEntries(join(cwd, '.hippo'))).toHaveLength(0);
  });

  it('refuses to run without a store and tells the user to run hippo init', async () => {
    const r = await capture('--file', file('notes.md', SPEC));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No hippo store at .*Run `hippo init` first/);
  });
});
