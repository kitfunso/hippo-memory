// readEmbeddingIdsReadOnly reads the ids a dashboard needs and never renames, copies or writes, unlike loadEmbeddingIndex.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEmbeddingIdsReadOnly } from '../src/embeddings.js';

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-emb-readonly-'));
  file = join(root, 'embeddings.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('readEmbeddingIdsReadOnly', () => {
  it('returns an empty set when the file is missing', () => {
    expect(readEmbeddingIdsReadOnly(root)).toEqual(new Set());
  });

  it('returns the ids of a valid index', () => {
    writeFileSync(file, JSON.stringify({ mem_a: [0.1], mem_b: [0.2, 0.3] }));

    expect(readEmbeddingIdsReadOnly(root)).toEqual(new Set(['mem_a', 'mem_b']));
  });

  it('returns null for a corrupt file and leaves it in place with no sibling', () => {
    writeFileSync(file, '{broken');

    expect(readEmbeddingIdsReadOnly(root)).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
    expect(readdirSync(root)).toEqual(['embeddings.json']);
  });

  it('returns null for an unreadable path and for a JSON array', () => {
    mkdirSync(file);
    expect(readEmbeddingIdsReadOnly(root)).toBeNull();

    rmSync(file, { recursive: true });
    writeFileSync(file, '[1, 2]');
    expect(readEmbeddingIdsReadOnly(root)).toBeNull();
  });

  it('warns once for an unreadable path read twice, and once more when the failure changes', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    mkdirSync(file);

    expect(readEmbeddingIdsReadOnly(root)).toBeNull();
    expect(readEmbeddingIdsReadOnly(root)).toBeNull();
    expect(lines.filter((l) => l.includes('embedding coverage is unknown'))).toHaveLength(1);
  });

  it('warns once when stat itself fails with the same code on every read', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    // A NUL byte makes statSync throw ERR_INVALID_ARG_VALUE on every platform, where a bad parent gives ENOENT on Windows.
    const invalid = `${root}\0bad`;

    expect(readEmbeddingIdsReadOnly(invalid)).toBeNull();
    expect(readEmbeddingIdsReadOnly(invalid)).toBeNull();
    expect(lines.filter((l) => l.includes('could not stat'))).toHaveLength(1);
  });

  it('serves the cached ids until the file changes in size or time', () => {
    writeFileSync(file, JSON.stringify({ mem_a: [0.1] }));
    const first = readEmbeddingIdsReadOnly(root);

    expect(readEmbeddingIdsReadOnly(root)).toBe(first);

    writeFileSync(file, JSON.stringify({ mem_a: [0.1], mem_b: [0.2] }));
    expect(readEmbeddingIdsReadOnly(root)).toEqual(new Set(['mem_a', 'mem_b']));
  });
});
