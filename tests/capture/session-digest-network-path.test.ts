// Transcript text naming a network host never reaches the filesystem: existsSync on \\host opens an SMB connection.
import * as fs from 'fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/base/config/config.js';
import { recordSessionDigest, type DigestEdit } from '../../src/surface/capture/session-digest.js';
import { isSessionDigestRow } from '../../src/base/session/session-digest-row.js';
import { makeRoot } from '../_helpers/make-root.js';
import { hookStore } from '../_helpers/cli-stores.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const HOST = /fileserver|example\.com|[\\/]opt[\\/]/i;
const probes: string[] = [];
const realExists = nodeFs.existsSync;

let tmp: string;
let repo: string;
let hippoRoot: string;

beforeEach(() => {
  tmp = makeRoot('digest-net', { init: false });
  fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
  repo = fs.realpathSync.native(path.join(tmp, 'repo'));
  hippoRoot = path.join(repo, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
  // A host-named probe answers false, so a broken guard fails the test without dialing out.
  vi.spyOn(nodeFs, 'existsSync').mockImplementation((p) => {
    probes.push(String(p));
    return HOST.test(String(p)) ? false : realExists(p);
  });
  syncBuiltinESMExports();
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
});

const touched = (): string[] => probes.filter((p) => HOST.test(p));

/** One session end on a fresh store: the line it logs and the digest it stores, '' for none. */
async function end(finalText: string, edits: DigestEdit[] = [], cwd = repo) {
  fs.rmSync(hippoRoot, { recursive: true, force: true });
  initTestStore(hippoRoot);
  const store = hookStore(hippoRoot);
  // Probes count from the session end itself, not the store set-up before it.
  probes.length = 0;
  const log: string[] = [];
  await recordSessionDigest(
    hippoRoot,
    store,
    { turns: [{ role: 'user', text: 'go' }], finalText, cwd, edits },
    {
      key: 's1',
      tenantId: 'default',
      config: loadConfig(hippoRoot),
      log: (line) => log.push(line),
    },
  );
  return {
    line: log.join('\n'),
    content: loadAllEntries(hippoRoot, 'default').find(isSessionDigestRow)?.content ?? '',
  };
}
const digest = async (finalText: string, edits: DigestEdit[] = []): Promise<string> =>
  (await end(finalText, edits)).content;

describe('network paths in a digest', () => {
  it('still probes a local repo path, so the checks below are live', async () => {
    expect(await digest('', [{ filePath: path.join(repo, 'src', 'a.ts'), base: null }])).toBe('Changed: src/a.ts');
    // Every module's existsSync is recorded; the digest's own probes walk the missing file up to its folder.
    expect(probes).toEqual(expect.arrayContaining([repo, path.join(repo, 'src', 'a.ts'), path.join(repo, 'src')]));
  });

  it.each([
    ['a web URL', 'Read the guide at https://docs.example.com/guide because `sync()` changed.'],
    ['a file URI', 'Loaded file:/opt/app/config.yaml because `boot()` needs it.'],
    ['a forward-slash share', 'Copied it to //fileserver/share/x.ts because `sync()` reads it.'],
    ['a backslash share', 'Copied it to \\\\fileserver\\share\\x.ts because `sync()` reads it.'],
  ])('a sentence naming %s keeps its text and probes nothing', async (_label, sentence) => {
    expect(await digest(sentence)).toBe(sentence);
    expect(touched()).toEqual([]);
  });

  it('an edit on a share is left out and probes nothing', async () => {
    const edits: DigestEdit[] = [
      { filePath: '//fileserver/share/x.ts', base: null },
      { filePath: '\\\\fileserver\\share\\y.ts', base: null },
      { filePath: '\\\\?\\UNC\\fileserver\\share\\z.ts', base: null },
      { filePath: 'w.ts', base: '//fileserver/share' },
    ];
    expect(await digest('', edits)).toBe('');
    expect(touched()).toEqual([]);
  });

  it.each([
    '//fileserver/share/x.ts',
    '\\\\fileserver\\share\\x.ts',
    '\\\\?\\UNC\\fileserver\\share\\x.ts',
    '\\\\.\\UNC\\fileserver\\share\\x.ts',
  ])('%s as the working directory resolves to no repo path without a probe', async (p) => {
    expect((await end('Fixed `sync()` because the share moved.', [], p)).line).toBe(
      'digest: skip: the session ran outside this repo',
    );
    expect(touched()).toEqual([]);
  });
});
