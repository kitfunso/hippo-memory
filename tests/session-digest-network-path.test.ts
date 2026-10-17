// Transcript text naming a network host never reaches the filesystem: existsSync on \\host opens an SMB connection.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setDigestExistsProbeForTests, recordSessionDigest, type DigestEdit } from '../src/capture/session-digest.js';
import { isSessionDigestRow } from '../src/core/session-digest-row.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const HOST = /fileserver|example\.com|[\\/]opt[\\/]/i;
const probes: string[] = [];

let tmp: string;
let repo: string;
let hippoRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-net-'));
  fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
  repo = fs.realpathSync.native(path.join(tmp, 'repo'));
  hippoRoot = path.join(repo, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
  probes.length = 0;
  // A host-named probe answers false, so a broken guard fails the test without dialing out.
  _setDigestExistsProbeForTests((p) => {
    probes.push(p);
    return HOST.test(p) ? false : fs.existsSync(p);
  });
});

afterEach(() => {
  _setDigestExistsProbeForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const touched = (): string[] => probes.filter((p) => HOST.test(p));

/** One session end on a fresh store: the line it logs and the digest it stores, '' for none. */
function end(finalText: string, edits: DigestEdit[] = [], cwd = repo) {
  fs.rmSync(hippoRoot, { recursive: true, force: true });
  initStore(hippoRoot);
  const log: string[] = [];
  recordSessionDigest(hippoRoot, { turns: [{ role: 'user', text: 'go' }], finalText, cwd, edits }, {
    key: 's1', tenantId: 'default', log: (line) => log.push(line),
  });
  return { line: log.join('\n'), content: loadAllEntries(hippoRoot, 'default').find(isSessionDigestRow)?.content ?? '' };
}
const digest = (finalText: string, edits: DigestEdit[] = []): string => end(finalText, edits).content;

describe('network paths in a digest', () => {
  it('still probes a local repo path, so the checks below are live', () => {
    expect(digest('', [{ filePath: path.join(repo, 'src', 'a.ts'), base: null }])).toBe('Changed: src/a.ts');
    expect(probes.length).toBeGreaterThan(0);
  });

  it.each([
    ['a web URL', 'Read the guide at https://docs.example.com/guide because `sync()` changed.'],
    ['a file URI', 'Loaded file:/opt/app/config.yaml because `boot()` needs it.'],
    ['a forward-slash share', 'Copied it to //fileserver/share/x.ts because `sync()` reads it.'],
    ['a backslash share', 'Copied it to \\\\fileserver\\share\\x.ts because `sync()` reads it.'],
  ])('a sentence naming %s keeps its text and probes nothing', (_label, sentence) => {
    expect(digest(sentence)).toBe(sentence);
    expect(touched()).toEqual([]);
  });

  it('an edit on a share is left out and probes nothing', () => {
    const edits: DigestEdit[] = [
      { filePath: '//fileserver/share/x.ts', base: null },
      { filePath: '\\\\fileserver\\share\\y.ts', base: null },
      { filePath: '\\\\?\\UNC\\fileserver\\share\\z.ts', base: null },
      { filePath: 'w.ts', base: '//fileserver/share' },
    ];
    expect(digest('', edits)).toBe('');
    expect(touched()).toEqual([]);
  });

  it.each([
    '//fileserver/share/x.ts',
    '\\\\fileserver\\share\\x.ts',
    '\\\\?\\UNC\\fileserver\\share\\x.ts',
    '\\\\.\\UNC\\fileserver\\share\\x.ts',
  ])('%s as the working directory resolves to no repo path without a probe', (p) => {
    expect(end('Fixed `sync()` because the share moved.', [], p).line).toBe('digest: skip: the session ran outside this repo');
    expect(touched()).toEqual([]);
  });
});
