/**
 * T1 regression tests (episode 01KX434KMAQSX4HRHYC67WDTJQ,
 * docs/plans/2026-07-09-recall-determinism.md).
 *
 * Covers two things:
 *  1. `embeddingInputText` excludes exactly `path:*` tags — the fix for the
 *     dominant root cause of cross-fresh-ingest recall-rank variance (auto
 *     path tags carry the store directory name, so identical content embeds
 *     to a different vector per store location).
 *  2. The reindex-identity choke point (`embeddingIndexIdentity`,
 *     `embeddingModelRequiresReindex`, `saveStoredEmbeddingModel`) versions
 *     consistently: a store just saved via the current format reports no
 *     reindex needed, while a legacy store with a bare (unversioned) stored
 *     model id reports a reindex is needed exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, setMeta } from '../src/db.js';
import {
  embeddingInputText,
  embeddingIndexIdentity,
  embeddingModelRequiresReindex,
  saveStoredEmbeddingModel,
  EMBEDDING_MODEL_META_KEY,
  EMBED_TEXT_FORMAT,
} from '../src/embeddings.js';

describe('embeddingInputText', () => {
  it('excludes tags starting with path: but keeps other tags', () => {
    const text = embeddingInputText({
      content: 'hello world',
      tags: ['path:c:/users/keith/hippo', 'conv:x', 'error', 'scope:private'],
    });
    expect(text).toBe('hello world conv:x error scope:private');
  });

  it('keeps a tag literally named pathfinder (startsWith, not includes)', () => {
    const text = embeddingInputText({
      content: 'hello world',
      tags: ['pathfinder', 'path:c:/users/keith/hippo'],
    });
    expect(text).toBe('hello world pathfinder');
  });

  it('returns content only, trimmed, when tags is empty', () => {
    const text = embeddingInputText({ content: 'hello world', tags: [] });
    expect(text).toBe('hello world');
  });

  it('returns content only, trimmed, when every tag is a path: tag', () => {
    const text = embeddingInputText({
      content: 'hello world',
      tags: ['path:c:/users/keith/hippo', 'path:hippo'],
    });
    expect(text).toBe('hello world');
  });

  it('excludes multiple path: tags interleaved with kept tags', () => {
    const text = embeddingInputText({
      content: 'note',
      tags: ['path:a', 'conv:x', 'path:a/b', 'dia:3', 'path:a/b/c'],
    });
    expect(text).toBe('note conv:x dia:3');
  });
});

describe('reindex identity consistency', () => {
  let root: string;
  let hippoRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-embed-identity-'));
    hippoRoot = join(root, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a store saved via saveStoredEmbeddingModel reports no reindex needed for the same model', () => {
    saveStoredEmbeddingModel(hippoRoot, 'modelX');
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };
    expect(embeddingModelRequiresReindex(hippoRoot, 'modelX', fakeIndex)).toBe(false);
  });

  it('a store saved via saveStoredEmbeddingModel still requires reindex for a different model', () => {
    saveStoredEmbeddingModel(hippoRoot, 'modelX');
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };
    expect(embeddingModelRequiresReindex(hippoRoot, 'modelY', fakeIndex)).toBe(true);
  });

  it('a legacy store with a bare (unversioned) stored model id requires reindex exactly once', () => {
    // Simulate a pre-T1 store: meta holds the bare provider id with no
    // `#t<N>` suffix, as `saveStoredEmbeddingModel` used to write it.
    const db = openHippoDb(hippoRoot);
    try {
      setMeta(db, EMBEDDING_MODEL_META_KEY, 'modelX');
    } finally {
      closeHippoDb(db);
    }
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };

    expect(embeddingModelRequiresReindex(hippoRoot, 'modelX', fakeIndex)).toBe(true);

    // The migration reindex re-saves the identity in the current format —
    // after that, the same model no longer requires reindex.
    saveStoredEmbeddingModel(hippoRoot, 'modelX');
    expect(embeddingModelRequiresReindex(hippoRoot, 'modelX', fakeIndex)).toBe(false);
  });

  it('embeddingIndexIdentity folds EMBED_TEXT_FORMAT into the provider id', () => {
    expect(embeddingIndexIdentity('modelX')).toBe(`modelX#t${EMBED_TEXT_FORMAT}`);
  });
});
