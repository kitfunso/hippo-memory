// The store keeps vectors; picking a provider, reading its config and checking its API key happen in the layer above (src/store/port.ts VectorWrites).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const storeDir = fileURLToPath(new URL('../../src/store/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('the store picks no embedding provider', () => {
  it('no src/store file imports the provider resolver', () => {
    const offenders = sources(storeDir).filter((f) => /embeddings\/provider\.js/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the store vector index exports no provider-driven embed entry point', async () => {
    const storeExports = Object.keys(await import('../../src/store/sqlite/vector-index.js'));
    expect(storeExports).not.toContain('embedMemory');
    expect(storeExports).not.toContain('embedAll');
    expect(Object.keys(await import('../../src/domain/search/embed-memories.js'))).toEqual(
      expect.arrayContaining(['embedMemory', 'embedAll']),
    );
  });
});
