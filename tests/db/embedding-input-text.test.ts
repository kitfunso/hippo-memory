import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb, setMeta } from '../../src/db/index.js';
import { embeddingInputText, embeddingIndexIdentity } from '../../src/base/embeddings/index-identity.js';
import {
  embeddingModelRequiresReindex,
  saveStoredEmbeddingModel,
} from '../../src/store/sqlite/vectors/vector-index.js';
import { EMBEDDING_MODEL_META_KEY } from '../../src/db/vector-store.js';
import { makeStore } from '../_helpers/make-root.js';
import { handlesOf } from '../../src/store/sqlite/runtime/handles.js';

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

  it('puts the lead-in after the content and before the tags, and ignores an empty or null one', () => {
    const entry = { content: 'Three times a week', tags: ['conv:x', 'path:a'] };
    expect(embeddingInputText({ ...entry, leadIn: 'user: how often?' })).toBe(
      'Three times a week\nuser: how often? conv:x',
    );
    for (const leadIn of [undefined, null, '']) {
      expect(embeddingInputText({ ...entry, leadIn })).toBe('Three times a week conv:x');
    }
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
  let hippoRoot: string;

  beforeEach(() => {
    ({ root: hippoRoot } = makeStore('embed-identity'));
  });

  it('a store saved via saveStoredEmbeddingModel reports no reindex needed for the same model', () => {
    saveStoredEmbeddingModel(handlesOf(hippoRoot).on, 'modelX');
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };
    expect(embeddingModelRequiresReindex(handlesOf(hippoRoot).on, 'modelX', fakeIndex)).toBe(false);
  });

  it('a store saved via saveStoredEmbeddingModel still requires reindex for a different model', () => {
    saveStoredEmbeddingModel(handlesOf(hippoRoot).on, 'modelX');
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };
    expect(embeddingModelRequiresReindex(handlesOf(hippoRoot).on, 'modelY', fakeIndex)).toBe(true);
  });

  it('a legacy store with a bare (unversioned) stored model id requires reindex exactly once', () => {
    const db = openHippoDb(hippoRoot);
    try {
      setMeta(db, EMBEDDING_MODEL_META_KEY, 'modelX');
    } finally {
      closeHippoDb(db);
    }
    const fakeIndex = { some_id: [0.1, 0.2, 0.3] };

    expect(embeddingModelRequiresReindex(handlesOf(hippoRoot).on, 'modelX', fakeIndex)).toBe(true);

    saveStoredEmbeddingModel(handlesOf(hippoRoot).on, 'modelX');
    expect(embeddingModelRequiresReindex(handlesOf(hippoRoot).on, 'modelX', fakeIndex)).toBe(false);
  });

  it('embeddingIndexIdentity folds text format 2 into the provider id', () => {
    expect(embeddingIndexIdentity('modelX')).toBe('modelX#t2');
  });
});
