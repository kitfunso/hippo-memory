// A provider's empty row is a per-item failure it already swallowed; embedAll must name the memory it left out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadEmbeddingIndex } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

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
  root = makeRoot('embed-skip');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('embedAll with a row the provider could not embed', () => {
  it('embeds the rest and warns once with the skipped memory id', async () => {
    const good = createMemory('the deploy runbook lives in the ops wiki', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const bad = createMemory('unembeddable row for the skip test', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, good);
    writeEntry(root, bad);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });

    expect(await embedAll(localIndex(root), undefined, partialProvider())).toBe(1);

    expect(Object.keys(loadEmbeddingIndex(root))).toEqual([good.id]);
    const warnings = lines.filter((l) => l.includes('not embedded'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`id=${bad.id}`);
  });
});
