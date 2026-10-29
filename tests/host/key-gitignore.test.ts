import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('leaves a read-only file that already lists the key as it is', () => {
    writeFileSync(ignoreFile(), 'server.key\n');
    chmodSync(ignoreFile(), 0o444);
    try {
      expect(() => ensureKeyGitignored(root)).not.toThrow();
      expect(readFileSync(ignoreFile(), 'utf8')).toBe('server.key\n');
    } finally {
      chmodSync(ignoreFile(), 0o644);
    }
  });

  it('adds nothing when a CRLF file already lists the key', () => {
    writeFileSync(ignoreFile(), 'a\r\nserver.key\r\n');
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe('a\r\nserver.key\r\n');
  });

  // Git takes the last rule that matches, and a leading space or a trailing tab is part of the pattern.
  it.each([
    ['a later negation', 'server.key\n!*.key\n'],
    ['a leading space', ' server.key\n'],
    ['a trailing tab', 'server.key\t\n'],
  ])('appends the key line when the file lists it but %s leaves it unignored', (_, text) => {
    writeFileSync(ignoreFile(), text);
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe(`${text}server.key\n`);
  });

  it.each([
    ['trailing spaces', 'server.key   \n'],
    ['a negation above it', '!*.key\nserver.key\n'],
    ['comments and blank lines below it', 'server.key\n# mine\n\n'],
  ])('adds nothing when the key line already wins despite %s', (_, text) => {
    writeFileSync(ignoreFile(), text);
    ensureKeyGitignored(root);
    expect(readFileSync(ignoreFile(), 'utf8')).toBe(text);
  });
});
