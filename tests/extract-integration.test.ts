import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, Layer } from '../src/memory.js';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { storeExtractedFacts, ExtractedFact } from '../src/extract.js';

let tmpDir: string;

function setup(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-extract-int-'));
  initStore(tmpDir);
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('storeExtractedFacts', () => {
  it('creates Semantic entries linked to source via extracted_from', () => {
    const dir = setup();
    const source = createMemory('Alice and Bob discussed the project timeline', {
      layer: Layer.Episodic,
      tags: ['conv:proj-meeting', 'session:s1'],
    });
    writeEntry(dir, source);

    const facts: ExtractedFact[] = [
      { content: 'Alice set the deadline to March 15', tags: ['speaker:Alice', 'topic:deadline'], valence: 'neutral' },
      { content: 'Bob prefers async standup meetings', tags: ['speaker:Bob', 'topic:standup'], valence: 'positive' },
    ];

    const entries = storeExtractedFacts(dir, source, facts);

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
      layer: Layer.Episodic,
      tags: ['conv:deploy-chat', 'session:s2', 'scope:backend', 'path:/app/deploy', 'other-tag'],
    });
    writeEntry(dir, source);

    const facts: ExtractedFact[] = [
      { content: 'Deploy uses blue-green strategy', tags: ['speaker:Carol', 'topic:deploy'], valence: 'neutral' },
    ];

    const entries = storeExtractedFacts(dir, source, facts);
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
      layer: Layer.Episodic,
    });
    writeEntry(dir, source);

    const entries = storeExtractedFacts(dir, source, []);
    expect(entries).toHaveLength(0);
  });
});
