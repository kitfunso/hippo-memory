// How a session digest picks its sentences and the files it lists. Pure functions over temp dirs; no store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isContentWorthStoring } from '../src/memory-quality.js';
import {
  MAX_DIGEST_CHARS,
  buildSessionDigest,
  digestSentences,
  realFsPath,
  type DigestEdit,
} from '../src/session-digest.js';

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-text-'));
  repo = String(realFsPath(path.join(tmp, 'repo')));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function digest(finalText: string, opts: { echo?: string[]; edits?: DigestEdit[] } = {}): string {
  return buildSessionDigest({ finalText, echoTexts: opts.echo ?? [], edits: opts.edits ?? [], repoRoot: repo })?.content ?? '';
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

  it('drops questions and lead-ins that end in a colon', () => {
    expect(digest('Should `retry()` back off in `upload.ts`?\nThe changes in `upload.ts` are:\n- none')).toBe('');
  });
});

describe('which sentences a digest keeps', () => {
  it('drops a sentence sharing six tokens in a row with a prompt, and keeps one sharing five', () => {
    const echo = ['please fix the flaky upload retry in the storage client today'];
    expect(digest('The flaky upload retry in the cache now waits because tokens expire.', { echo })).toBe('');
    expect(digest('Fixed flaky upload retry in the parser because tokens expire.', { echo })).toBe(
      'Fixed flaky upload retry in the parser because tokens expire.',
    );
  });

  it('drops sentences that open on a referent, and keeps There', () => {
    expect(digest('This fixes the lock in `a.ts`. All 9 pass in `b.ts`. Both tests use `c.ts` now.')).toBe('');
    expect(digest('There is a race in `a.ts` because the lock is shared.')).toBe('There is a race in `a.ts` because the lock is shared.');
  });

  it('ranks anchored or reasoned sentences first and prints them in reply order', () => {
    const text = [
      'Done with the work for today.',
      'Plain sentence one here.',
      'Plain sentence two here.',
      'Plain sentence three here.',
      'Plain sentence four here.',
      'Switched `retry()` to exponential backoff because the API rate limits.',
      'Moved the lock into src/pool.ts.',
    ].join(' ');
    expect(lines(digest(text))).toEqual([
      'Done with the work for today.',
      'Plain sentence one here.',
      'Plain sentence two here.',
      'Switched `retry()` to exponential backoff because the API rate limits.',
      'Moved the lock into src/pool.ts.',
    ]);
  });

  it('keeps at most five sentences', () => {
    const text = Array.from({ length: 8 }, (_, i) => `Fixed \`step${i}()\` because input ${i} was empty.`).join(' ');
    expect(lines(digest(text))).toEqual(Array.from({ length: 5 }, (_, i) => `Fixed \`step${i}()\` because input ${i} was empty.`));
  });

  it('drops a sentence over 300 chars', () => {
    expect(digest(`Retried \`upload()\` ${'with a longer wait '.repeat(16)}because tokens expire.`)).toBe('');
  });

  it('writes content that passes the recent-N quality floor', () => {
    const out = digest('Retry `upload()` with backoff because the token expires mid-transfer.', {
      edits: [{ filePath: path.join(repo, 'src', 'upload.ts'), base: null }],
    });
    expect(out).toContain('Changed: src/upload.ts');
    expect(isContentWorthStoring(out)).toBe(true);
  });
});

describe('secrets and paths in sentences', () => {
  const jwt = (n: number): string => `eyJ${'A'.repeat(n)}.eyJ${'B'.repeat(n)}.${'C'.repeat(n)}`;

  it('redacts a token', () => {
    const out = digest('Called `hook()` with AKIAIOSFODNN7EXAMPLE because staging needs it.');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts before the 300-char cap, so a long token costs its sentence nothing', () => {
    const sentence = `Called \`hook()\` with ${jwt(100)} because staging needs it.`;
    expect(sentence.length).toBeGreaterThan(300);
    expect(digest(sentence)).toBe('Called `hook()` with [REDACTED] because staging needs it.');
  });

  it('redacts before the total cap, so a kept secret is masked and costs no other sentence its place', () => {
    const top = 'Switched `retry()` to backoff because the API rate limits.';
    const filler = (i: number): string => `Plain filler sentence number ${i} ${'with some more words '.repeat(12)}here.`;
    const secret = jwt(80);
    const second = `Fixed \`last()\` with ${secret} because staging needed it.`;
    const kept = [top, filler(1), filler(2), filler(3), second];
    expect(kept.join('\n').length).toBeGreaterThan(MAX_DIGEST_CHARS);
    expect(lines(digest(kept.join(' ')))).toEqual([...kept.slice(0, 4), 'Fixed `last()` with [REDACTED] because staging needed it.']);
  });

  it('redacts a private key block that spans lines', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    const out = digest(`Rotated the key in \`sign()\` because it leaked.\n${pem}\nMoved it to the vault because \`deploy()\` reads it there.`);
    expect(out).toContain('Rotated the key');
    expect(out).not.toMatch(/AAAA|BBBB|PRIVATE KEY/);
  });

  it('redacts a secret inside a path, in a sentence and in the Changed line', () => {
    const file = path.join(repo, 'src', 'AKIAIOSFODNN7EXAMPLE.ts');
    const out = digest(`Moved the loader into src/AKIAIOSFODNN7EXAMPLE.ts because \`load()\` reads it.`, {
      edits: [{ filePath: file, base: null }],
    });
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(lines(out)).toEqual(['Moved the loader into src/[REDACTED].ts because `load()` reads it.', 'Changed: src/[REDACTED].ts']);
  });

  it('rewrites an absolute path inside the repo to a repo-relative one', () => {
    const out = digest(`Fixed the race in ${path.join(repo, 'src', 'pool.ts')} because the lock was shared.`);
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
  ])('drops a sentence naming %s', (_label, where) => {
    expect(digest(`Kept the notes in ${where} because \`sync()\` reads them.`)).toBe('');
  });

  it('keeps git revision syntax such as HEAD~1', () => {
    expect(digest('Reverted HEAD~1 because `merge()` dropped a row.')).toBe('Reverted HEAD~1 because `merge()` dropped a row.');
  });
});

describe('the Changed line', () => {
  const at = (...parts: string[]): string => path.join(repo, ...parts);

  it('lists repo-relative paths once each, in first-edit order', () => {
    const edits: DigestEdit[] = [
      { filePath: at('src', 'b.ts'), base: null },
      { filePath: 'src/a.ts', base: repo },
      { filePath: at('src', 'b.ts'), base: null },
      { filePath: 'b.ts', base: at('src') },
    ];
    expect(digest('', { edits })).toBe('Changed: src/b.ts, src/a.ts');
  });

  it('leaves out paths outside the repo and relative paths with no base', () => {
    const edits: DigestEdit[] = [
      { filePath: path.join(tmp, 'elsewhere.ts'), base: null },
      { filePath: '../outside.ts', base: repo },
      { filePath: 'src/orphan.ts', base: null },
      { filePath: at('src', 'kept.ts'), base: null },
    ];
    expect(digest('', { edits })).toBe('Changed: src/kept.ts');
  });

  it('lists deleted files differing only in case once on Windows, twice elsewhere', () => {
    const edits: DigestEdit[] = [{ filePath: at('src', 'Old.ts'), base: null }, { filePath: at('src', 'old.ts'), base: null }];
    expect(digest('', { edits })).toBe(process.platform === 'win32' ? 'Changed: src/Old.ts' : 'Changed: src/Old.ts, src/old.ts');
  });

  it('caps the list at ten files', () => {
    const edits = Array.from({ length: 15 }, (_, i): DigestEdit => ({ filePath: at('src', `f${i}.ts`), base: null }));
    const out = digest('', { edits });
    expect(out).toBe(`Changed: ${Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`).join(', ')} (+5 more)`);
  });

  it('keeps the Changed line when the sentences fill the cap', () => {
    const text = Array.from({ length: 5 }, (_, i) => `Fixed \`part${i}()\` because ${'the input was empty and '.repeat(10)}done.`).join(' ');
    const edits = Array.from({ length: 12 }, (_, i): DigestEdit => ({ filePath: at('src', `file-${i}.ts`), base: null }));
    const out = digest(text, { edits });
    expect(out.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(lines(out).at(-1)).toMatch(/^Changed: src\/file-0\.ts, .* \(\+2 more\)$/);
    expect(lines(out).length).toBeLessThan(6);
  });

  it.runIf(process.platform === 'win32')('reads Windows spellings of a repo path', () => {
    const file = at('src', 'win.ts');
    fs.writeFileSync(file, '');
    const gitBash = `/${file[0].toLowerCase()}${file.slice(2).replace(/\\/g, '/')}`;
    for (const filePath of [gitBash, `\\\\?\\${file}`, file.toUpperCase(), file.replace(/\\/g, '/')]) {
      expect(digest('', { edits: [{ filePath, base: null }] }), filePath).toMatch(/^Changed: src\/win\.ts$/i);
    }
  });
});
