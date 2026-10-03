// A provider's empty row is a per-item failure it already swallowed; embedAll must name the memory it left out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { embedAll, loadEmbeddingIndex } from '../src/embeddings.js';
import type { EmbeddingProvider } from '../src/embedding-provider.js';

/** Embeds every text except the ones marked unembeddable, which get the `[]` a local provider returns on a per-item failure. */
function partialProvider(): EmbeddingProvider {
  return {
    kind: 'local',
    model: 'partial-test-model',
    id: 'partial-test-model',
    isAvailable: () => true,
    embed: async (texts: string[]) => texts.map((t) => (t.includes('unembeddable') ? [] : [1, 0])),
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-skip-'));
  initStore(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('embedAll with a row the provider could not embed', () => {
  it('embeds the rest and warns once with the skipped memory id', async () => {
    const good = createMemory('the deploy runbook lives in the ops wiki');
    const bad = createMemory('unembeddable row for the skip test');
    writeEntry(root, good);
    writeEntry(root, bad);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });

    expect(await embedAll(root, undefined, partialProvider())).toBe(1);

    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([good.id]);
    const warnings = lines.filter((l) => l.includes('not embedded'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`id=${bad.id}`);
  });
});
