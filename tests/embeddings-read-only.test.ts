// readEmbeddingIdsReadOnly reads the ids a dashboard needs and never renames, copies or writes, unlike loadEmbeddingIndex.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('serves the cached ids until the file changes in size or time', () => {
    writeFileSync(file, JSON.stringify({ mem_a: [0.1] }));
    const first = readEmbeddingIdsReadOnly(root);

    expect(readEmbeddingIdsReadOnly(root)).toBe(first);

    writeFileSync(file, JSON.stringify({ mem_a: [0.1], mem_b: [0.2] }));
    expect(readEmbeddingIdsReadOnly(root)).toEqual(new Set(['mem_a', 'mem_b']));
  });
});
