// Transcript text naming a network host never reaches the filesystem: existsSync on \\host opens an SMB connection.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setDigestExistsProbeForTests, buildSessionDigest, realFsPath, repoRelative, type DigestEdit } from '../src/capture/session-digest.js';

const HOST = /fileserver|example\.com|[\\/]opt[\\/]/i;
const probes: string[] = [];

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-net-'));
  fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
  repo = String(realFsPath(path.join(tmp, 'repo')));
  probes.length = 0;
  // A host-named probe answers false, so a broken guard fails the test without dialing out.
  _setDigestExistsProbeForTests((p) => {
    probes.push(p);
    return HOST.test(p) ? false : fs.existsSync(p);
  });
});

afterEach(() => {
  _setDigestExistsProbeForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const touched = (): string[] => probes.filter((p) => HOST.test(p));
const digest = (finalText: string, edits: DigestEdit[] = []): string =>
  buildSessionDigest({ finalText, echoTexts: [], edits, repoRoot: repo })?.content ?? '';

describe('network paths in a digest', () => {
  it('still probes a local repo path, so the checks below are live', () => {
    expect(repoRelative(path.join(repo, 'src', 'a.ts'), repo)).toBe('src/a.ts');
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
  ])('%s resolves to null without a probe', (p) => {
    expect(realFsPath(p)).toBeNull();
    expect(repoRelative(p, repo)).toBeNull();
    expect(touched()).toEqual([]);
  });
});
