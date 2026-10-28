import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureKeyGitignored } from '../../src/host/key-gitignore.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-keyignore-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const ignoreFile = () => join(root, '.gitignore');

describe('ensureKeyGitignored', () => {
  it('creates the file with the key line in a fresh folder', () => {
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('server.key\n');
  });

  it('keeps the lines a folder already has, even without a final newline', () => {
    writeFileSync(ignoreFile(), '*.log\n# mine\nbackups/');
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('*.log\n# mine\nbackups/\nserver.key\n');
  });

  it('adds nothing on a second run', () => {
    ensureKeyGitignored(root);
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('server.key\n');
  });

  it('adds nothing when a CRLF file already lists the key', () => {
    writeFileSync(ignoreFile(), 'a\r\nserver.key\r\n');
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('a\r\nserver.key\r\n');
  });
});
