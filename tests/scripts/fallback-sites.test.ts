// An api or domain read of an optional group with a fallback (an F group) sits at one of seven pinned
// sites, each with the reason no root binds it (PR body, section 3); a new one fails here until it is named.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONAL_GROUPS } from '../../src/base/ports/store.js';

const REPO = join(import.meta.dirname, '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

/** The interface each optional group is typed by, read from the port files. */
function groupInterfaces(): string[] {
  const ports = ['store.ts', 'store-groups.ts'].map((f) => readFileSync(join(REPO, 'src/base/ports', f), 'utf8'));
  const typed = new Map([...ports.join('\n').matchAll(/readonly (\w+): (\w+);/g)].map((m) => [m[1], m[2]]));
  return OPTIONAL_GROUPS.map((group) => typed.get(group) ?? group);
}

function fallbackReads(): string[] {
  const optionalMember = new RegExp(`\\w+\\?: (?:${groupInterfaces().join('|')})\\b`);
  const fallbackForms = [
    /ContextWith<[^<>]*,[^<>]*>/,
    /StoreWith<[^<>]*,[^<>]*>/,
    /Partial<Pick<StoreGroups/,
    /Partial<StoreGroups>/,
    /Pick<Partial<StoreGroups/,
    optionalMember,
  ];
  const found: string[] = [];
  for (const file of [...tsFiles(join(REPO, 'src/api')), ...tsFiles(join(REPO, 'src/domain'))]) {
    const path = relative(REPO, file).split(sep).join('/');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const form of fallbackForms) {
        const hit = form.exec(line)?.[0];
        // The generic definition itself, which names no group.
        if (hit !== undefined && hit !== 'StoreWith<G, F>') found.push(`${path}: ${hit}`);
      }
    }
  }
  return found.sort();
}

describe('fallback reads of optional groups', () => {
  it('sit at the seven pinned sites and nowhere else', () => {
    expect(fallbackReads()).toEqual(
      [
        // 1-2. vectorSourceOf and graphStoresOf: the searched store is picked per call.
        "src/domain/search/hybrid.ts: StoreWith<never, 'vectors' | 'graphReads'>",
        "src/domain/search/hybrid.ts: StoreWith<never, 'graphReads'>",
        "src/domain/search/hybrid.ts: StoreWith<never, 'vectors' | 'graphReads'>",
        "src/domain/search/physics-search.ts: StoreWith<never, 'vectors' | 'graphReads'>",
        'src/domain/search/vector.ts: graphReads?: GraphReads',
        // 3. Graph expansion walks ctx.store and ctx.global.store.
        "src/api/recall/pipeline.ts: StoreWith<never, 'vectors' | 'graphReads'>",
        "src/domain/graph/recall.ts: StoreWith<never, 'graphReads'>",
        // 4. The unfinished-handoff read on plan.local.store.
        "src/api/context-select.ts: StoreWith<never, 'sessions'>",
        "src/api/context.ts: StoreWith<never, 'sessions'>",
        // 5. lastRecall: published entries hand in any store.
        "src/api/context.ts: ContextWith<never, 'lastRecall'>",
        // 6. embeddingIndex: published entries hand in any store or folder.
        "src/domain/search/embed-memories.ts: StoreWith<never, 'embeddingIndex' | 'vectors' | 'vectorWrites'>",
        // 7. sharing and folderFiles: the published sleep entry takes any folder.
        "src/api/sleep/sleep-run.ts: ContextWith<SleepGroup, 'sharing' | 'folderFiles'>",
      ].sort(),
    );
  });
});
