// How a session digest picks its sentences and the files it lists, read back from the row a fresh store keeps.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../../src/core/config.js';
import { isContentWorthStoring } from '../../src/core/memory-quality.js';
import { isSessionDigestRow } from '../../src/core/session-digest-row.js';
import { digestSentences, recordSessionDigest, type DigestEdit } from '../../src/capture/session-digest.js';
import { makeRoot } from '../_helpers/make-root.js';
import { hookStore } from '../_helpers/cli-stores.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';

// The digest keeps to 1200 chars; pinned here so a change to the cap shows up as a test edit.
const MAX_DIGEST_CHARS = 1200;
// A run that stores nothing for one of these reasons did so because of its text, never its setup.
const TEXT_SKIPS = new Set([
  'digest: skip: nothing left after the filters',
  'digest: skip: no final message and no edits',
]);

let tmp: string;
let repo: string;
let hippoRoot: string;

beforeEach(() => {
  tmp = makeRoot('digest-text', { init: false });
  fs.mkdirSync(path.join(tmp, 'repo', 'src'), { recursive: true });
  repo = fs.realpathSync.native(path.join(tmp, 'repo'));
  hippoRoot = path.join(repo, '.hippo');
  vi.stubEnv('HIPPO_HOME', path.join(tmp, 'global'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The digest a session ending on `finalText` stores, '' for none. A fresh store each call, so no earlier digest echoes. */
async function digest(finalText: string, opts: { echo?: string[]; edits?: DigestEdit[] } = {}): Promise<string> {
  fs.rmSync(hippoRoot, { recursive: true, force: true });
  initStore(hippoRoot);
  const turns = (opts.echo ?? ['go']).map((text) => ({ role: 'user' as const, text }));
  const log: string[] = [];
  await recordSessionDigest(
    hippoRoot,
    hookStore(hippoRoot),
    { turns, finalText, cwd: repo, edits: opts.edits ?? [] },
    {
      key: 's1',
      tenantId: 'default',
      config: loadConfig(hippoRoot),
      log: (line) => log.push(line),
    },
  );
  const line = log.join('\n');
  if (!line.startsWith('digest: wrote ') && !TEXT_SKIPS.has(line)) throw new Error(line);
  return loadAllEntries(hippoRoot, 'default').find(isSessionDigestRow)?.content ?? '';
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

describe('splitting the final message', () => {
  it('keeps code spans and versions whole', () => {
    expect(digestSentences('`a.b()` fails when empty. Pin v1.2.3 in src/x.ts.')).toEqual([
      '`a.b()` fails when empty.',
      'Pin v1.2.3 in src/x.ts.',
    ]);
  });

  it('holds e.g. and i.e. out of the split', () => {
    expect(digestSentences('Use a lock, e.g. a mutex in `pool.ts`, because two writers race.')).toHaveLength(1);
  });

  it('drops fences, headings, tables, quotes and rules; strips bullets and bold', () => {
    const text = [
      '## Summary',
      '```ts',
      'const retries = 3; // never shown',
      '```',
      '| file | change |',
      '> quoted from the ticket',
      '---',
      '- **Retry** the upload in `upload.ts` because tokens expire.',
    ].join('\n');
    expect(digestSentences(text)).toEqual(['Retry the upload in `upload.ts` because tokens expire.']);
  });

  it('drops questions and lead-ins that end in a colon', async () => {
    expect(await digest('Should `retry()` back off in `upload.ts`?\nThe changes in `upload.ts` are:\n- none')).toBe('');
  });
});

describe('which sentences a digest keeps', () => {
  it('drops a sentence sharing six tokens in a row with a prompt, and keeps one sharing five', async () => {
    const echo = ['please fix the flaky upload retry in the storage client today'];
    expect(await digest('The flaky upload retry in the cache now waits because tokens expire.', { echo })).toBe('');
    expect(await digest('Fixed flaky upload retry in the parser because tokens expire.', { echo })).toBe(
      'Fixed flaky upload retry in the parser because tokens expire.',
    );
  });

  it('drops sentences that open on a referent, and keeps There', async () => {
    expect(await digest('This fixes the lock in `a.ts`. All 9 pass in `b.ts`. Both tests use `c.ts` now.')).toBe('');
    expect(await digest('There is a race in `a.ts` because the lock is shared.')).toBe(
      'There is a race in `a.ts` because the lock is shared.',
    );
  });

  it('ranks anchored or reasoned sentences first and prints them in reply order', async () => {
    const text = [
      'Done with the work for today.',
      'Plain sentence one here.',
      'Plain sentence two here.',
      'Plain sentence three here.',
      'Plain sentence four here.',
      'Switched `retry()` to exponential backoff because the API rate limits.',
      'Moved the lock into src/pool.ts.',
    ].join(' ');
    expect(lines(await digest(text))).toEqual([
      'Done with the work for today.',
      'Plain sentence one here.',
      'Plain sentence two here.',
      'Switched `retry()` to exponential backoff because the API rate limits.',
      'Moved the lock into src/pool.ts.',
    ]);
  });

  it('keeps at most five sentences', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `Fixed \`step${i}()\` because input ${i} was empty.`).join(' ');
    expect(lines(await digest(text))).toEqual(
      Array.from({ length: 5 }, (_, i) => `Fixed \`step${i}()\` because input ${i} was empty.`),
    );
  });

  it('drops a sentence over 300 chars', async () => {
    expect(await digest(`Retried \`upload()\` ${'with a longer wait '.repeat(16)}because tokens expire.`)).toBe('');
  });

  it('writes content that passes the recent-N quality floor', async () => {
    const out = await digest('Retry `upload()` with backoff because the token expires mid-transfer.', {
      edits: [{ filePath: path.join(repo, 'src', 'upload.ts'), base: null }],
    });
    expect(out).toContain('Changed: src/upload.ts');
    expect(isContentWorthStoring(out)).toBe(true);
  });
});

describe('secrets and paths in sentences', () => {
  const jwt = (n: number): string => `eyJ${'A'.repeat(n)}.eyJ${'B'.repeat(n)}.${'C'.repeat(n)}`;

  it('redacts a token', async () => {
    const out = await digest('Called `hook()` with AKIAIOSFODNN7EXAMPLE because staging needs it.');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts before the 300-char cap, so a long token costs its sentence nothing', async () => {
    const sentence = `Called \`hook()\` with ${jwt(100)} because staging needs it.`;
    expect(sentence.length).toBeGreaterThan(300);
    expect(await digest(sentence)).toBe('Called `hook()` with [REDACTED] because staging needs it.');
  });

  it('redacts before the total cap, so a kept secret is masked and costs no other sentence its place', async () => {
    const top = 'Switched `retry()` to backoff because the API rate limits.';
    const filler = (i: number): string =>
      `Plain filler sentence number ${i} ${'with some more words '.repeat(12)}here.`;
    const secret = jwt(80);
    const second = `Fixed \`last()\` with ${secret} because staging needed it.`;
    const kept = [top, filler(1), filler(2), filler(3), second];
    expect(kept.join('\n').length).toBeGreaterThan(MAX_DIGEST_CHARS);
    expect(lines(await digest(kept.join(' ')))).toEqual([
      ...kept.slice(0, 4),
      'Fixed `last()` with [REDACTED] because staging needed it.',
    ]);
  });

  it('redacts a private key block that spans lines', async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    const out = await digest(
      `Rotated the key in \`sign()\` because it leaked.\n${pem}\nMoved it to the vault because \`deploy()\` reads it there.`,
    );
    expect(out).toContain('Rotated the key');
    expect(out).not.toMatch(/AAAA|BBBB|PRIVATE KEY/);
  });

  it('redacts a secret inside a path, in a sentence and in the Changed line', async () => {
    const file = path.join(repo, 'src', 'AKIAIOSFODNN7EXAMPLE.ts');
    const out = await digest(`Moved the loader into src/AKIAIOSFODNN7EXAMPLE.ts because \`load()\` reads it.`, {
      edits: [{ filePath: file, base: null }],
    });
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(lines(out)).toEqual([
      'Moved the loader into src/[REDACTED].ts because `load()` reads it.',
      'Changed: src/[REDACTED].ts',
    ]);
  });

  it('rewrites an absolute path inside the repo to a repo-relative one', async () => {
    const out = await digest(`Fixed the race in ${path.join(repo, 'src', 'pool.ts')} because the lock was shared.`);
    expect(out).toBe('Fixed the race in src/pool.ts because the lock was shared.');
  });

  it.each([
    ['a Windows home', 'D:\\Users\\alice\\notes\\todo.md'],
    ['a forward-slash Windows home', 'D:/Users/alice/notes/todo.md'],
    ['a Git Bash home', '/d/Users/alice/notes/todo.md'],
    ['a long-path prefix', '\\\\?\\E:\\work\\todo.md'],
    ['a Linux home', '/home/alice/notes/todo.md'],
    ['a macOS home', '/Users/alice/notes/todo.md'],
    ['an 8.3 short name', 'E:\\ALICEM~1\\notes\\todo.md'],
    ['a WSL home', '/mnt/d/Users/alice/notes/todo.md'],
    ['a Silverblue home', '/var/home/alice/notes/todo.md'],
    ['the root home', '/root/notes/todo.md'],
    ['an XP-era home', 'D:\\Documents and Settings\\alice\\todo.md'],
  ])('drops a sentence naming %s', async (_label, where) => {
    expect(await digest(`Kept the notes in ${where} because \`sync()\` reads them.`)).toBe('');
  });

  it('keeps git revision syntax such as HEAD~1', async () => {
    expect(await digest('Reverted HEAD~1 because `merge()` dropped a row.')).toBe(
      'Reverted HEAD~1 because `merge()` dropped a row.',
    );
  });
});

describe('the Changed line', () => {
  const at = (...parts: string[]): string => path.join(repo, ...parts);

  it('lists repo-relative paths once each, in first-edit order', async () => {
    const edits: DigestEdit[] = [
      { filePath: at('src', 'b.ts'), base: null },
      { filePath: 'src/a.ts', base: repo },
      { filePath: at('src', 'b.ts'), base: null },
      { filePath: 'b.ts', base: at('src') },
    ];
    expect(await digest('', { edits })).toBe('Changed: src/b.ts, src/a.ts');
  });

  it('leaves out paths outside the repo and relative paths with no base', async () => {
    const edits: DigestEdit[] = [
      { filePath: path.join(tmp, 'elsewhere.ts'), base: null },
      { filePath: '../outside.ts', base: repo },
      { filePath: 'src/orphan.ts', base: null },
      { filePath: at('src', 'kept.ts'), base: null },
    ];
    expect(await digest('', { edits })).toBe('Changed: src/kept.ts');
  });

  it('lists deleted files differing only in case once on Windows, twice elsewhere', async () => {
    const edits: DigestEdit[] = [
      { filePath: at('src', 'Old.ts'), base: null },
      { filePath: at('src', 'old.ts'), base: null },
    ];
    expect(await digest('', { edits })).toBe(
      process.platform === 'win32' ? 'Changed: src/Old.ts' : 'Changed: src/Old.ts, src/old.ts',
    );
  });

  it('caps the list at ten files', async () => {
    const edits = Array.from({ length: 15 }, (_, i): DigestEdit => ({ filePath: at('src', `f${i}.ts`), base: null }));
    const out = await digest('', { edits });
    expect(out).toBe(`Changed: ${Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`).join(', ')} (+5 more)`);
  });

  it('keeps the Changed line when the sentences fill the cap', async () => {
    const text = Array.from(
      { length: 5 },
      (_, i) => `Fixed \`part${i}()\` because ${'the input was empty and '.repeat(10)}done.`,
    ).join(' ');
    const edits = Array.from({ length: 12 }, (_, i): DigestEdit => ({
      filePath: at('src', `file-${i}.ts`),
      base: null,
    }));
    const out = await digest(text, { edits });
    expect(out.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(lines(out).at(-1)).toMatch(/^Changed: src\/file-0\.ts, .* \(\+2 more\)$/);
    expect(lines(out).length).toBeLessThan(6);
  });

  it.runIf(process.platform === 'win32')('reads Windows spellings of a repo path', async () => {
    const file = at('src', 'win.ts');
    fs.writeFileSync(file, '');
    const gitBash = `/${file[0].toLowerCase()}${file.slice(2).replace(/\\/g, '/')}`;
    for (const filePath of [gitBash, `\\\\?\\${file}`, file.toUpperCase(), file.replace(/\\/g, '/')]) {
      expect(await digest('', { edits: [{ filePath, base: null }] }), filePath).toMatch(/^Changed: src\/win\.ts$/i);
    }
  });
});
