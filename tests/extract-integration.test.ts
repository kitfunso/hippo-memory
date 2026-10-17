import { describe, it, expect } from 'vitest';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { readEntry } from '../src/store/entry-reads.js';
import { storeExtractedFacts, ExtractedFact } from '../src/learn/extract.js';
import { sqliteSyncStore } from '../src/store/sqlite/store.js';
import { makeRoot } from './_helpers/make-root.js';

let tmpDir: string;

function setup(): string {
  tmpDir = makeRoot('extract-int');
  return tmpDir;
}

describe('storeExtractedFacts', () => {
  it('creates Semantic entries linked to source via extracted_from', () => {
    const dir = setup();
    const source = createMemory('Alice and Bob discussed the project timeline', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      tags: ['conv:proj-meeting', 'session:s1'],
    });
    writeEntry(dir, source);

    const facts: ExtractedFact[] = [
      { content: 'Alice set the deadline to March 15', tags: ['speaker:Alice', 'topic:deadline'], valence: 'neutral' },
      { content: 'Bob prefers async standup meetings', tags: ['speaker:Bob', 'topic:standup'], valence: 'positive' },
    ];

    const entries = storeExtractedFacts(sqliteSyncStore(dir).localFiles.learning, source, facts, DEFAULT_HALF_LIFE_DAYS);

    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect(entry.layer).toBe(Layer.Semantic);
      expect(entry.extracted_from).toBe(source.id);
      expect(entry.confidence).toBe('inferred');
      expect(entry.tags).toContain('extracted');

      const loaded = readEntry(dir, entry.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.extracted_from).toBe(source.id);
    }

    expect(entries[0]!.content).toBe('Alice set the deadline to March 15');
    expect(entries[1]!.content).toBe('Bob prefers async standup meetings');
  });

  it('inherits conv:, session:, scope:, path: tags from source', () => {
    const dir = setup();
    const source = createMemory('Discussion about deployment', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
      tags: ['conv:deploy-chat', 'session:s2', 'scope:backend', 'path:/app/deploy', 'other-tag'],
    });
    writeEntry(dir, source);

    const facts: ExtractedFact[] = [
      { content: 'Deploy uses blue-green strategy', tags: ['speaker:Carol', 'topic:deploy'], valence: 'neutral' },
    ];

    const entries = storeExtractedFacts(sqliteSyncStore(dir).localFiles.learning, source, facts, DEFAULT_HALF_LIFE_DAYS);
    expect(entries).toHaveLength(1);

    const tags = entries[0]!.tags;
    expect(tags).toContain('extracted');
    expect(tags).toContain('conv:deploy-chat');
    expect(tags).toContain('session:s2');
    expect(tags).toContain('scope:backend');
    expect(tags).toContain('path:/app/deploy');
    expect(tags).toContain('speaker:Carol');
    expect(tags).toContain('topic:deploy');
    expect(tags).not.toContain('other-tag');
  });

  it('returns empty array when no facts provided', () => {
    const dir = setup();
    const source = createMemory('Small talk about weather', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Episodic,
    });
    writeEntry(dir, source);

    const entries = storeExtractedFacts(sqliteSyncStore(dir).localFiles.learning, source, [], DEFAULT_HALF_LIFE_DAYS);
    expect(entries).toHaveLength(0);
  });
});
