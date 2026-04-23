# Fact Extraction → DAG Summarization → Multi-Hop Retrieval

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the LoCoMo gap from 20% to 70%+ by adding write-time fact extraction, hierarchical DAG organization, and chained multi-hop retrieval.

**Architecture:** Three incremental phases, each independently shippable. Phase 1 adds LLM-based fact extraction at remember-time, storing extracted facts as Semantic entries linked to their source episodic memory. Phase 2 builds topic-level DAG summaries during consolidation. Phase 3 adds two-pass retrieval for multi-hop questions. Each phase preserves the existing bio-inspired decay, retrieval strengthening, and consolidation mechanics.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Anthropic API (Claude claude-sonnet-4-6 for extraction), Vitest, existing `@xenova/transformers` embeddings.

**LoCoMo Baseline:** v0.32.0 scores 20% overall (single-hop 18%, multi-hop 23%, temporal 16%, open-domain 18%, adversarial 27%). Score degrades from 55% at ~400 memories to 0% at ~680 memories.

---

## Phase 1: Write-Time Fact Extraction (v0.33)

**Why:** The #1 root cause is raw utterance storage. `"John: Yeah, basketball is really important to me..."` matches loosely on everything basketball-related but not on the specific question `"What are John's basketball career goals?"`. Extraction turns this into `"John considers basketball his primary passion and trains daily to improve."` which matches precisely.

**Target:** LoCoMo 20% → 45-55%.

---

### Task 1: Schema v12 — extracted_from column

Add a column linking extracted facts back to their source memory. Using a dedicated column (not parents_json) because the semantic relationship is different: "extracted from" vs "consolidated from".

**Files:**
- Modify: `src/db.ts:24` (schema version) and `src/db.ts:236` (new migration)
- Modify: `src/store.ts:41-66` (MemoryRow interface)
- Modify: `src/store.ts` (MEMORY_SELECT_COLUMNS, rowToEntry, upsertEntryRow, deserializeEntry)
- Modify: `src/memory.ts:21-46` (MemoryEntry interface)
- Test: `tests/extraction-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/extraction-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

describe('schema v12: extracted_from', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('stores and retrieves extracted_from field', () => {
    const source = createMemory('raw utterance about basketball', {});
    writeEntry(hippoRoot, source);

    const fact = createMemory('John plays basketball daily', {
      extracted_from: source.id,
    });
    writeEntry(hippoRoot, fact);

    const loaded = readEntry(hippoRoot, fact.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.extracted_from).toBe(source.id);
  });

  it('defaults extracted_from to null for regular memories', () => {
    const entry = createMemory('a normal memory', {});
    writeEntry(hippoRoot, entry);

    const loaded = readEntry(hippoRoot, entry.id);
    expect(loaded!.extracted_from).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extraction-schema.test.ts`
Expected: FAIL — `extracted_from` not in MemoryEntry interface

**Step 3: Implement the schema change**

In `src/memory.ts:45`, add after `superseded_by`:
```typescript
extracted_from: string | null;  // ID of the raw memory this fact was extracted from; null = not extracted
```

In `src/memory.ts` `createMemory()`, add to the entry construction:
```typescript
extracted_from: options.extracted_from ?? null,
```

In `src/db.ts:24`, bump:
```typescript
const CURRENT_SCHEMA_VERSION = 12;
```

In `src/db.ts`, add migration v12 after v11:
```typescript
{
  version: 12,
  up: (db) => {
    if (!tableHasColumn(db, 'memories', 'extracted_from')) {
      db.exec(`ALTER TABLE memories ADD COLUMN extracted_from TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_extracted_from ON memories(extracted_from) WHERE extracted_from IS NOT NULL`);
  },
},
```

In `src/store.ts` MemoryRow interface, add:
```typescript
extracted_from: string | null;
```

In `src/store.ts` MEMORY_SELECT_COLUMNS, append `, extracted_from`.

In `src/store.ts` rowToEntry, add:
```typescript
extracted_from: row.extracted_from ?? null,
```

In `src/store.ts` upsertEntryRow, add `extracted_from` to the INSERT columns, VALUES placeholders, ON CONFLICT UPDATE, and .run() params:
```typescript
entry.extracted_from,
```

In `src/store.ts` deserializeEntry, add fallback:
```typescript
extracted_from: (frontmatter.extracted_from as string) ?? null,
```

Update `tests/pr2-session-continuity.test.ts` schema version assertion from 11 to 12.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extraction-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db.ts src/memory.ts src/store.ts tests/extraction-schema.test.ts tests/pr2-session-continuity.test.ts
git commit -m "feat: schema v12 — add extracted_from column for fact extraction"
```

---

### Task 2: Extraction module — core LLM fact extractor

The extraction module calls Claude to extract structured facts from raw text. Follows the same `refine-llm.ts` pattern: direct fetch, no SDK dependency, fallback-safe.

**Files:**
- Create: `src/extract.ts`
- Test: `tests/extract.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractFacts, type ExtractedFact } from '../src/extract.js';

describe('extractFacts', () => {
  it('parses a valid LLM response into ExtractedFact[]', async () => {
    const mockResponse = JSON.stringify([
      {
        content: 'John plays basketball competitively and trains daily',
        tags: ['speaker:John', 'topic:basketball'],
        valence: 'positive',
      },
      {
        content: 'John wants to improve his shooting percentage',
        tags: ['speaker:John', 'topic:basketball', 'topic:goals'],
        valence: 'neutral',
      },
    ]);

    const mockFetcher = async (_url: string | URL | Request, _opts?: RequestInit) => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: mockResponse }],
        }),
        { status: 200 },
      );
    };

    const facts = await extractFacts(
      '[5:26 pm on 2 January, 2024] John: Yeah, basketball is still really important to me',
      { apiKey: 'test-key', fetcher: mockFetcher as typeof fetch },
    );

    expect(facts).toHaveLength(2);
    expect(facts[0].content).toContain('basketball');
    expect(facts[0].tags).toContain('speaker:John');
    expect(facts[1].content).toContain('shooting percentage');
  });

  it('returns empty array on API failure', async () => {
    const mockFetcher = async () => new Response('', { status: 500 });
    const facts = await extractFacts('some text', {
      apiKey: 'test-key',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(facts).toEqual([]);
  });

  it('returns empty array on malformed JSON response', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'not valid json' }] }),
        { status: 200 },
      );
    const facts = await extractFacts('some text', {
      apiKey: 'test-key',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(facts).toEqual([]);
  });

  it('caps extraction at 8 facts max', async () => {
    const tooMany = Array.from({ length: 12 }, (_, i) => ({
      content: `fact ${i}`,
      tags: [],
      valence: 'neutral',
    }));
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(tooMany) }] }),
        { status: 200 },
      );
    const facts = await extractFacts('some text', {
      apiKey: 'test-key',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(facts.length).toBeLessThanOrEqual(8);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extract.test.ts`
Expected: FAIL — module `../src/extract.js` not found

**Step 3: Implement the extraction module**

```typescript
// src/extract.ts
import type { EmotionalValence } from './memory.js';

const MAX_FACTS = 8;

export interface ExtractedFact {
  content: string;
  tags: string[];
  valence: EmotionalValence;
}

export interface ExtractOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
}

const EXTRACTION_PROMPT = `You are extracting discrete facts from a conversation turn for a memory system.

Input: a timestamped conversation turn (e.g. "[date] Speaker: text").

Extract 1-8 standalone facts. Each fact should be a complete, self-contained statement that answers a potential future question. Focus on:
- Specific claims, preferences, goals, opinions
- Named entities (people, places, organizations, dates)
- Relationships between entities
- Temporal information (when things happened or will happen)
- Quantitative details (numbers, amounts, frequencies)

Rules:
- Output ONLY a JSON array. No preamble, no markdown fences.
- Each element: {"content": "...", "tags": ["speaker:Name", "topic:X"], "valence": "neutral|positive|negative|critical"}
- Content must be a standalone sentence (not "He likes X" but "John likes X")
- Include the speaker name in every fact's content
- Preserve specific details: names, numbers, dates, locations
- If the turn is small talk with no extractable facts, return []

Turn to extract from:
`;

export async function extractFacts(
  text: string,
  opts: ExtractOptions,
): Promise<ExtractedFact[]> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const fetchFn = opts.fetcher ?? fetch;

  let res: Response;
  try {
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: EXTRACTION_PROMPT + text }],
      }),
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  try {
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text?.trim() ?? '';
    if (!raw) return [];

    // Strip markdown fences if the model wraps them
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

    const parsed = JSON.parse(cleaned) as Array<{
      content?: string;
      tags?: string[];
      valence?: string;
    }>;

    if (!Array.isArray(parsed)) return [];

    const validValences = new Set(['neutral', 'positive', 'negative', 'critical']);

    return parsed
      .filter((f) => typeof f.content === 'string' && f.content.length >= 5)
      .slice(0, MAX_FACTS)
      .map((f) => ({
        content: f.content!,
        tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
        valence: (validValences.has(f.valence ?? '') ? f.valence : 'neutral') as EmotionalValence,
      }));
  } catch {
    return [];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/extract.ts tests/extract.test.ts
git commit -m "feat: add LLM-based fact extraction module"
```

---

### Task 3: Extraction integration — wire into remember flow

Connect the extraction module to `hippo remember` so facts are extracted and stored alongside the raw memory.

**Files:**
- Modify: `src/cli.ts` (cmdRemember function, ~lines 300-400)
- Modify: `src/config.ts:11-61` (add extraction config)
- Modify: `src/config.ts:63-103` (defaults)
- Modify: `src/config.ts:105-137` (loadConfig merge)
- Test: `tests/extract-integration.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/extract-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, readEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { storeExtractedFacts } from '../src/extract.js';

describe('storeExtractedFacts integration', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-test-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('stores extracted facts as Semantic entries linked to source', () => {
    const source = createMemory('[5pm] John: I love basketball', {
      layer: Layer.Episodic,
      tags: ['conv:1'],
    });
    writeEntry(hippoRoot, source);

    const facts = [
      { content: 'John loves basketball', tags: ['speaker:John'], valence: 'positive' as const },
    ];

    const stored = storeExtractedFacts(hippoRoot, source, facts);
    expect(stored).toHaveLength(1);

    const loaded = readEntry(hippoRoot, stored[0].id);
    expect(loaded).not.toBeNull();
    expect(loaded!.layer).toBe(Layer.Semantic);
    expect(loaded!.extracted_from).toBe(source.id);
    expect(loaded!.tags).toContain('extracted');
    expect(loaded!.confidence).toBe('inferred');
    expect(loaded!.content).toBe('John loves basketball');
  });

  it('inherits source tags plus extraction-specific tags', () => {
    const source = createMemory('text', {
      tags: ['conv:1', 'session:2'],
    });
    writeEntry(hippoRoot, source);

    const facts = [
      { content: 'a fact', tags: ['speaker:John', 'topic:basketball'], valence: 'neutral' as const },
    ];

    const stored = storeExtractedFacts(hippoRoot, source, facts);
    const loaded = readEntry(hippoRoot, stored[0].id);
    // Should have source tags + fact-specific tags + 'extracted'
    expect(loaded!.tags).toContain('conv:1');
    expect(loaded!.tags).toContain('speaker:John');
    expect(loaded!.tags).toContain('extracted');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/extract-integration.test.ts`
Expected: FAIL — `storeExtractedFacts` not exported from extract.ts

**Step 3: Implement storeExtractedFacts + config**

Add to `src/extract.ts`:
```typescript
import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { writeEntry } from './store.js';

export function storeExtractedFacts(
  hippoRoot: string,
  source: MemoryEntry,
  facts: ExtractedFact[],
): MemoryEntry[] {
  const stored: MemoryEntry[] = [];

  // Inherit source tags that provide context (conv, session, scope)
  const inheritedTags = source.tags.filter(
    (t) => t.startsWith('conv:') || t.startsWith('session:') || t.startsWith('scope:') || t.startsWith('path:'),
  );

  for (const fact of facts) {
    const mergedTags = [...new Set([...inheritedTags, ...fact.tags, 'extracted'])];
    const entry = createMemory(fact.content, {
      layer: Layer.Semantic,
      tags: mergedTags,
      emotional_valence: fact.valence,
      confidence: 'inferred',
      extracted_from: source.id,
    });
    writeEntry(hippoRoot, entry);
    stored.push(entry);
  }

  return stored;
}
```

Add to `src/config.ts` HippoConfig interface (after pinnedInject):
```typescript
extraction: {
  enabled: boolean | 'auto';  // 'auto' = extract when API key available
  model: string;
};
```

Add to DEFAULT_CONFIG:
```typescript
extraction: {
  enabled: 'auto',
  model: 'claude-sonnet-4-6',
},
```

Add to loadConfig merge:
```typescript
extraction: { ...DEFAULT_CONFIG.extraction, ...(raw.extraction ?? {}) },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/extract-integration.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/extract.ts src/config.ts tests/extract-integration.test.ts
git commit -m "feat: storeExtractedFacts + extraction config"
```

---

### Task 4: CLI --extract flag on hippo remember

Wire the `--extract` flag into the CLI remember command so users can trigger extraction from the command line.

**Files:**
- Modify: `src/cli.ts` (cmdRemember function + flag parsing)
- Test: `tests/cli-extract.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/cli-extract.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

describe('hippo remember --extract', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-extract-'));
    execSync(`hippo init --no-hooks --no-schedule --no-learn`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('accepts --extract flag without crashing (no API key = no extraction, memory still saved)', () => {
    // Without ANTHROPIC_API_KEY, extraction should silently skip but the raw memory should still be stored
    const result = execSync(
      `hippo remember "John loves basketball" --extract`,
      {
        cwd: hippoRoot,
        env: { ...process.env, HIPPO_HOME: hippoRoot, ANTHROPIC_API_KEY: '' },
        encoding: 'utf-8',
      },
    );
    expect(result).toContain('Remembered');

    // Verify the raw memory was stored
    const recallResult = execSync(
      `hippo recall basketball --json`,
      {
        cwd: hippoRoot,
        env: { ...process.env, HIPPO_HOME: hippoRoot },
        encoding: 'utf-8',
      },
    );
    expect(recallResult).toContain('basketball');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-extract.test.ts`
Expected: FAIL — `--extract` flag not recognized (or extraction function not wired)

**Step 3: Implement CLI wiring**

In `src/cli.ts` cmdRemember, after the memory is written:

1. Add `--extract` to the flag parsing (where `--tag`, `--pin`, `--error` etc. are parsed)
2. After `writeEntry(hippoRoot, entry)`, add:

```typescript
const shouldExtract = flags['extract'] || config.extraction.enabled === true;
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

if (shouldExtract && apiKey) {
  try {
    const { extractFacts, storeExtractedFacts } = await import('./extract.js');
    const facts = await extractFacts(entry.content, {
      apiKey,
      model: config.extraction.model,
    });
    if (facts.length > 0) {
      storeExtractedFacts(hippoRoot, entry, facts);
      console.error(`  extracted ${facts.length} fact(s)`);
    }
  } catch {
    // Extraction is best-effort — never block remember
  }
} else if (shouldExtract && !apiKey) {
  console.error('  (extraction skipped: ANTHROPIC_API_KEY not set)');
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli-extract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli.ts tests/cli-extract.test.ts
git commit -m "feat: hippo remember --extract flag for write-time fact extraction"
```

---

### Task 5: Search preference for extracted facts

When both raw memories and their extracted facts exist, search should prefer the extracted facts (they match more precisely) and avoid returning both the raw and the fact for the same source.

**Files:**
- Modify: `src/search.ts` (hybridSearch and search functions)
- Test: `tests/search-extraction-preference.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/search-extraction-preference.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

describe('search extraction preference', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-search-extract-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('prefers extracted fact over its raw source in results', () => {
    // Raw memory: vague about basketball
    const raw = createMemory(
      '[5pm] John: Yeah, basketball is still really important to me, I practice every day',
      { layer: Layer.Episodic, tags: ['conv:1'] },
    );
    writeEntry(hippoRoot, raw);

    // Extracted fact: precise about goals
    const fact = createMemory(
      'John considers basketball his primary passion and practices daily to improve his skills',
      {
        layer: Layer.Semantic,
        tags: ['extracted', 'speaker:John', 'topic:basketball'],
        extracted_from: raw.id,
        confidence: 'inferred',
      },
    );
    writeEntry(hippoRoot, fact);

    const entries = loadAllEntries(hippoRoot);
    const results = search('basketball daily practice', entries, { budget: 4000 });

    // Both may appear, but fact should rank higher or raw should be deduplicated
    const factResult = results.find((r) => r.entry.id === fact.id);
    const rawResult = results.find((r) => r.entry.id === raw.id);

    if (factResult && rawResult) {
      // If both appear, fact should score higher
      expect(factResult.score).toBeGreaterThan(rawResult.score);
    } else {
      // Or raw should be deduplicated away
      expect(factResult).toBeDefined();
    }
  });

  it('does not deduplicate unrelated memories', () => {
    const m1 = createMemory('Alice likes tennis', { tags: ['sport'] });
    const m2 = createMemory('Bob likes football', { tags: ['sport'] });
    writeEntry(hippoRoot, m1);
    writeEntry(hippoRoot, m2);

    const entries = loadAllEntries(hippoRoot);
    const results = search('sports', entries, { budget: 4000 });

    // Both should remain
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search-extraction-preference.test.ts`
Expected: PASS or FAIL depending on scoring — the key test is the dedup behavior

**Step 3: Implement extraction-aware deduplication**

In `src/search.ts`, add a post-scoring deduplication step in both `hybridSearch` and `search`. After scoring and sorting, before budget enforcement:

```typescript
// Deduplicate: when an extracted fact and its source both appear,
// keep only the higher-scoring one (typically the fact).
const seenSources = new Map<string, number>(); // extracted_from → best index
const deduped: typeof scored = [];
for (let i = 0; i < scored.length; i++) {
  const entry = scored[i].entry;
  if (entry.extracted_from) {
    // This is an extracted fact — check if source already in results
    const sourceIdx = deduped.findIndex((d) => d.entry.id === entry.extracted_from);
    if (sourceIdx >= 0) {
      // Fact beats source: remove source, add fact
      deduped.splice(sourceIdx, 1);
    }
    seenSources.set(entry.extracted_from, deduped.length);
    deduped.push(scored[i]);
  } else if (seenSources.has(entry.id)) {
    // This raw memory's fact is already in results — skip it
    continue;
  } else {
    deduped.push(scored[i]);
  }
}
```

Also add a 1.3x scoring boost for extracted facts (tag `extracted`) in the multiplier chain:
```typescript
const extractionBoost = entry.tags.includes('extracted') ? 1.3 : 1.0;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search-extraction-preference.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (no regressions)

**Step 6: Commit**

```bash
git add src/search.ts tests/search-extraction-preference.test.ts
git commit -m "feat: search deduplication and scoring boost for extracted facts"
```

---

### Task 6: Consolidation — skip extracted facts during merge

The consolidation merge pass clusters episodic memories by Jaccard overlap. Extracted facts (Semantic, tag: extracted) should be excluded from merge clustering — they're already distilled.

**Files:**
- Modify: `src/consolidate.ts` (merge pass, ~lines 304-353)
- Test: `tests/consolidate-extraction.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/consolidate-extraction.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';

describe('consolidation skips extracted facts', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-consol-extract-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('does not merge extracted facts into new semantic entries', () => {
    // Two similar extracted facts — should NOT be merged
    const f1 = createMemory('John plays basketball daily', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      extracted_from: 'source-1',
    });
    const f2 = createMemory('John practices basketball every day to improve', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      extracted_from: 'source-2',
    });
    writeEntry(hippoRoot, f1);
    writeEntry(hippoRoot, f2);

    const result = consolidate(hippoRoot, { dryRun: false });
    expect(result.merged).toBe(0);

    // Both facts should still exist unchanged
    const entries = loadAllEntries(hippoRoot);
    const facts = entries.filter((e) => e.tags.includes('extracted'));
    expect(facts).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/consolidate-extraction.test.ts`
Expected: May PASS or FAIL depending on Jaccard overlap threshold

**Step 3: Implement the guard**

In `src/consolidate.ts` merge pass (around line 310), add an early filter:

```typescript
// Exclude extracted facts from merge clustering — they're already distilled
const mergeCandidates = survivors.filter(
  (e) => e.layer === Layer.Episodic && !e.tags.includes('extracted'),
);
```

Replace the existing episodic filter with this.

Also in `detectConflicts` (around line 423), add:
```typescript
if (survivors[i].tags.includes('extracted') || survivors[j].tags.includes('extracted')) continue;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/consolidate-extraction.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/consolidate.ts tests/consolidate-extraction.test.ts
git commit -m "feat: consolidation skips extracted facts during merge pass"
```

---

### Task 7: Batch extraction during hippo sleep

Add a new consolidation phase: for episodic memories that lack extracted facts, batch-extract during sleep. This catches memories created with `hippo remember` (no `--extract`) or before the extraction feature existed.

**Files:**
- Modify: `src/consolidate.ts` (add extraction phase after replay)
- Test: `tests/consolidate-batch-extract.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/consolidate-batch-extract.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';

describe('batch extraction during consolidation', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-batch-extract-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('extracts facts from episodic memories that lack them', async () => {
    const raw = createMemory('[5pm] John: I scored 30 points yesterday', {
      layer: Layer.Episodic,
    });
    writeEntry(hippoRoot, raw);

    // Mock: set ANTHROPIC_API_KEY but use a mock fetcher via config
    // For this test, we verify the consolidation result includes extractionCount
    const result = consolidate(hippoRoot, {
      dryRun: false,
      // extraction will be skipped without API key — that's fine for this test
    });

    // The result should report how many were candidates for extraction
    expect(result).toHaveProperty('extractionCandidates');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/consolidate-batch-extract.test.ts`
Expected: FAIL — `extractionCandidates` not in ConsolidationResult

**Step 3: Implement batch extraction phase**

In `src/consolidate.ts`:

1. Add `extractionCandidates` and `extracted` to ConsolidationResult interface.

2. Add a new phase after replay (before merge):
```typescript
// --- Phase: Batch extraction ---
// Find episodic memories with no extracted facts
const extractedFromIds = new Set(
  survivors.filter((e) => e.extracted_from).map((e) => e.extracted_from!),
);
const extractionCandidates = survivors.filter(
  (e) => e.layer === Layer.Episodic && !extractedFromIds.has(e.id),
);
result.extractionCandidates = extractionCandidates.length;

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
if (apiKey && extractionCandidates.length > 0 && !dryRun) {
  const { extractFacts, storeExtractedFacts } = await import('./extract.js');
  const config = loadConfig(hippoRoot);
  const batchLimit = 20; // cap per sleep cycle
  let extracted = 0;
  for (const candidate of extractionCandidates.slice(0, batchLimit)) {
    try {
      const facts = await extractFacts(candidate.content, {
        apiKey,
        model: config.extraction.model,
      });
      if (facts.length > 0) {
        storeExtractedFacts(hippoRoot, candidate, facts);
        extracted += facts.length;
      }
    } catch {
      // Best-effort
    }
  }
  result.extracted = extracted;
}
```

3. Make `consolidate()` async (change signature, update callers in cli.ts).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/consolidate-batch-extract.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/consolidate.ts tests/consolidate-batch-extract.test.ts
git commit -m "feat: batch fact extraction during hippo sleep consolidation"
```

---

### Task 8: LoCoMo re-benchmark + Phase 1 validation

Re-run the LoCoMo benchmark with extraction enabled to measure the impact of Phase 1.

**Files:**
- Modify: `benchmarks/locomo/run.py` (add extraction during ingestion)
- No test file — this is a benchmark run

**Step 1: Update the benchmark harness**

In `benchmarks/locomo/run.py`, modify `hippo_remember()` to pass `--extract`:

```python
def hippo_remember(hippo_home: str, text: str, tags: list[str]) -> bool:
    args = ["remember", text, "--extract"]
    for t in tags:
        args.extend(["--tag", t])
    try:
        result = run_hippo(args, cwd=hippo_home, hippo_home=hippo_home, timeout=60)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        logger.warning("remember timed out for: %.80s", text)
        return False
```

Note: increased timeout from 30 to 60 to account for API calls.

**Step 2: Run a 2-conversation pilot**

```bash
cd benchmarks/locomo
ANTHROPIC_API_KEY=<key> python run.py \
  --data data/locomo10.json \
  --output-dir results/ \
  --output-name hippo-v0.33.0-extract.json \
  --conversations 2 \
  --verbose
```

**Step 3: Compare results**

```bash
python finalize.py results/hippo-v0.33.0-extract.json results/hippo-v0.32.0.json
```

Expected: Meaningful improvement on single-hop and open-domain categories.

**Step 4: Full 10-conversation run**

```bash
nohup python run.py \
  --data data/locomo10.json \
  --output-dir results/ \
  --output-name hippo-v0.33.0-extract.json \
  --resume \
  --verbose > results/run-v0.33.0-extract.log 2>&1 &
```

**Step 5: Commit harness changes**

```bash
git add benchmarks/locomo/run.py
git commit -m "bench: enable --extract in LoCoMo harness for v0.33 benchmark"
```

---

## Phase 2: DAG Summarization (v0.34)

**Why:** Even with extraction, 200+ facts per conversation is still a large search space. DAG organizes facts into a navigable hierarchy: topic clusters → entity profiles → facts. Search starts broad (match summary) and drills into the relevant branch.

**Target:** LoCoMo 45-55% → 60-70%.

**Prerequisite:** Phase 1 complete and validated.

---

### Task 9: Schema v13 — dag_parent_id + dag_level columns

Add hierarchy support. Each memory gets a DAG level (0=raw, 1=fact, 2=topic_summary, 3=entity_profile) and can point to a DAG parent (the summary node above it).

**Files:**
- Modify: `src/db.ts` (schema version 13 + migration)
- Modify: `src/memory.ts` (MemoryEntry interface)
- Modify: `src/store.ts` (MemoryRow, columns, serialization)
- Test: `tests/dag-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/dag-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

describe('schema v13: DAG fields', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('stores dag_level and dag_parent_id', () => {
    const summary = createMemory('John is a basketball player who trains daily', {
      layer: Layer.Semantic,
      dag_level: 2,
    });
    writeEntry(hippoRoot, summary);

    const fact = createMemory('John scored 30 points on Jan 2', {
      layer: Layer.Semantic,
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, fact);

    const loadedFact = readEntry(hippoRoot, fact.id);
    expect(loadedFact!.dag_level).toBe(1);
    expect(loadedFact!.dag_parent_id).toBe(summary.id);

    const loadedSummary = readEntry(hippoRoot, summary.id);
    expect(loadedSummary!.dag_level).toBe(2);
    expect(loadedSummary!.dag_parent_id).toBeNull();
  });

  it('defaults dag_level to 0 and dag_parent_id to null', () => {
    const entry = createMemory('plain memory', {});
    writeEntry(hippoRoot, entry);

    const loaded = readEntry(hippoRoot, entry.id);
    expect(loaded!.dag_level).toBe(0);
    expect(loaded!.dag_parent_id).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dag-schema.test.ts`
Expected: FAIL — `dag_level` not in MemoryEntry

**Step 3: Implement schema changes**

In `src/memory.ts`, add to MemoryEntry:
```typescript
dag_level: number;            // 0=raw, 1=extracted_fact, 2=topic_summary, 3=entity_profile
dag_parent_id: string | null; // ID of parent summary node in the DAG; null = root level
```

In `createMemory`, add:
```typescript
dag_level: options.dag_level ?? 0,
dag_parent_id: options.dag_parent_id ?? null,
```

In `src/db.ts`, bump to v13 and add migration:
```typescript
{
  version: 13,
  up: (db) => {
    if (!tableHasColumn(db, 'memories', 'dag_level')) {
      db.exec(`ALTER TABLE memories ADD COLUMN dag_level INTEGER NOT NULL DEFAULT 0`);
    }
    if (!tableHasColumn(db, 'memories', 'dag_parent_id')) {
      db.exec(`ALTER TABLE memories ADD COLUMN dag_parent_id TEXT`);
    }
    // Set existing extracted facts to level 1
    db.exec(`UPDATE memories SET dag_level = 1 WHERE extracted_from IS NOT NULL AND dag_level = 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_dag_parent ON memories(dag_parent_id) WHERE dag_parent_id IS NOT NULL`);
  },
},
```

Mirror changes in store.ts (MemoryRow, columns, rowToEntry, upsertEntryRow, deserializeEntry).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dag-schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db.ts src/memory.ts src/store.ts tests/dag-schema.test.ts
git commit -m "feat: schema v13 — DAG hierarchy fields (dag_level, dag_parent_id)"
```

---

### Task 10: Topic clustering module

Cluster extracted facts by entity and topic. Uses TF-IDF cosine similarity (no LLM needed) to group related facts. This is the input for DAG summary generation.

**Files:**
- Create: `src/dag.ts`
- Test: `tests/dag-cluster.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/dag-cluster.test.ts
import { describe, it, expect } from 'vitest';
import { clusterFacts } from '../src/dag.js';
import { createMemory, Layer } from '../src/memory.js';

describe('clusterFacts', () => {
  it('groups facts by entity/topic overlap', () => {
    const facts = [
      createMemory('John plays basketball daily', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
      }),
      createMemory('John wants to improve shooting percentage', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
      }),
      createMemory('Tim enjoys reading sci-fi novels', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim', 'topic:reading'],
      }),
      createMemory('Tim recently read Dune by Frank Herbert', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim', 'topic:reading'],
      }),
    ];

    const clusters = clusterFacts(facts);

    // Should produce at least 2 clusters: John-basketball and Tim-reading
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    // Each cluster should have related facts
    const johnCluster = clusters.find((c) =>
      c.members.some((m) => m.content.includes('John')),
    );
    expect(johnCluster).toBeDefined();
    expect(johnCluster!.members.length).toBeGreaterThanOrEqual(2);
    expect(johnCluster!.label).toContain('John');
  });

  it('returns singletons as their own cluster', () => {
    const facts = [
      createMemory('Alice likes chess', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Alice'],
      }),
    ];

    const clusters = clusterFacts(facts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dag-cluster.test.ts`
Expected: FAIL — module not found

**Step 3: Implement clustering**

```typescript
// src/dag.ts
import type { MemoryEntry } from './memory.js';

export interface FactCluster {
  label: string;          // e.g. "John: basketball"
  members: MemoryEntry[];
  entityTags: string[];   // shared speaker/topic tags
}

export function clusterFacts(facts: MemoryEntry[]): FactCluster[] {
  if (facts.length === 0) return [];

  // Extract entity tags (speaker:X, topic:Y) per fact
  const entityTags = facts.map((f) =>
    f.tags.filter((t) => t.startsWith('speaker:') || t.startsWith('topic:')),
  );

  // Group by shared entity tag set (Jaccard >= 0.5)
  const assigned = new Set<number>();
  const clusters: FactCluster[] = [];

  for (let i = 0; i < facts.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: number[] = [i];
    assigned.add(i);

    for (let j = i + 1; j < facts.length; j++) {
      if (assigned.has(j)) continue;
      const shared = entityTags[i].filter((t) => entityTags[j].includes(t));
      const union = new Set([...entityTags[i], ...entityTags[j]]);
      const jaccard = union.size > 0 ? shared.length / union.size : 0;
      if (jaccard >= 0.5) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    const members = cluster.map((idx) => facts[idx]);
    const sharedTags = entityTags[cluster[0]].filter((t) =>
      cluster.every((idx) => entityTags[idx].includes(t)),
    );
    const label = sharedTags
      .map((t) => t.split(':')[1])
      .join(': ') || members[0].content.slice(0, 40);

    clusters.push({ label, members, entityTags: sharedTags });
  }

  return clusters;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dag-cluster.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dag.ts tests/dag-cluster.test.ts
git commit -m "feat: topic clustering for extracted facts"
```

---

### Task 11: DAG summary generation

For each topic cluster with 3+ facts, generate a summary node using LLM. The summary becomes the cluster's DAG parent. During search, matching a summary surfaces its children.

**Files:**
- Modify: `src/dag.ts` (add generateDagSummaries)
- Test: `tests/dag-summarize.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/dag-summarize.test.ts
import { describe, it, expect } from 'vitest';
import { generateDagSummary } from '../src/dag.js';

describe('generateDagSummary', () => {
  it('produces a summary from cluster label and member contents', async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'John is a dedicated basketball player who trains daily and aims to improve his shooting percentage and win a championship.' }],
        }),
        { status: 200 },
      );

    const summary = await generateDagSummary(
      'John: basketball',
      [
        'John plays basketball daily',
        'John wants to improve shooting percentage',
        'John dreams of winning a championship',
      ],
      { apiKey: 'test', fetcher: mockFetcher as typeof fetch },
    );

    expect(summary).not.toBeNull();
    expect(summary!).toContain('basketball');
  });

  it('returns null on API failure', async () => {
    const mockFetcher = async () => new Response('', { status: 500 });
    const summary = await generateDagSummary('label', ['fact'], {
      apiKey: 'test',
      fetcher: mockFetcher as typeof fetch,
    });
    expect(summary).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dag-summarize.test.ts`
Expected: FAIL — function not exported

**Step 3: Implement summary generation**

Add to `src/dag.ts`:

```typescript
export interface DagSummaryOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
}

const DAG_SUMMARY_PROMPT = `You are summarizing a cluster of facts about a specific topic/entity for a memory system.

Topic: {label}
Facts:
{facts}

Write a single concise paragraph (2-4 sentences) that captures all the key information from these facts. This summary will be used to quickly determine if this cluster is relevant to a future query, so include specific names, dates, numbers, and key details. Output ONLY the summary paragraph, no preamble.`;

export async function generateDagSummary(
  label: string,
  factContents: string[],
  opts: DagSummaryOptions,
): Promise<string | null> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const fetchFn = opts.fetcher ?? fetch;

  const factsBlock = factContents.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const prompt = DAG_SUMMARY_PROMPT
    .replace('{label}', label)
    .replace('{facts}', factsBlock);

  let res: Response;
  try {
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  try {
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim() ?? '';
    return text.length >= 20 ? text : null;
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dag-summarize.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dag.ts tests/dag-summarize.test.ts
git commit -m "feat: LLM-powered DAG summary generation for topic clusters"
```

---

### Task 12: DAG construction during consolidation

Wire DAG building into the consolidation (sleep) pipeline. After batch extraction, cluster extracted facts and generate summary nodes for clusters with 3+ members.

**Files:**
- Modify: `src/consolidate.ts` (add DAG build phase)
- Modify: `src/dag.ts` (add `buildDag` orchestrator)
- Test: `tests/consolidate-dag.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/consolidate-dag.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';

describe('DAG construction during consolidation', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-build-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('reports dagCandidateClusters in consolidation result', async () => {
    // Create enough extracted facts to form a cluster
    for (let i = 0; i < 4; i++) {
      const fact = createMemory(`John basketball fact ${i}`, {
        layer: Layer.Semantic,
        tags: ['extracted', 'speaker:John', 'topic:basketball'],
        extracted_from: `source-${i}`,
        dag_level: 1,
      });
      writeEntry(hippoRoot, fact);
    }

    const result = await consolidate(hippoRoot, { dryRun: false });
    expect(result).toHaveProperty('dagCandidateClusters');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/consolidate-dag.test.ts`
Expected: FAIL — `dagCandidateClusters` not in result

**Step 3: Implement DAG build phase in consolidation**

Add to `src/dag.ts`:

```typescript
import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { writeEntry } from './store.js';

export interface DagBuildResult {
  candidateClusters: number;
  summariesCreated: number;
  factsLinked: number;
}

export async function buildDag(
  hippoRoot: string,
  facts: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<DagBuildResult> {
  const result: DagBuildResult = { candidateClusters: 0, summariesCreated: 0, factsLinked: 0 };

  // Only cluster facts at dag_level 1 that don't already have a parent
  const unparented = facts.filter(
    (f) => f.dag_level === 1 && !f.dag_parent_id && f.tags.includes('extracted'),
  );

  const clusters = clusterFacts(unparented);
  const eligibleClusters = clusters.filter((c) => c.members.length >= 3);
  result.candidateClusters = eligibleClusters.length;

  for (const cluster of eligibleClusters) {
    const summary = await generateDagSummary(
      cluster.label,
      cluster.members.map((m) => m.content),
      opts,
    );
    if (!summary) continue;

    // Create summary node
    const summaryEntry = createMemory(summary, {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, 'dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
    });
    writeEntry(hippoRoot, summaryEntry);
    result.summariesCreated++;

    // Link children to parent
    for (const member of cluster.members) {
      const updated: MemoryEntry = { ...member, dag_parent_id: summaryEntry.id };
      writeEntry(hippoRoot, updated);
      result.factsLinked++;
    }
  }

  return result;
}
```

In `src/consolidate.ts`, add DAG build phase after extraction phase:

```typescript
// --- Phase: DAG summarization ---
const extractedFacts = survivors.filter(
  (e) => e.tags.includes('extracted') && e.dag_level === 1,
);
if (apiKey && extractedFacts.length >= 3 && !dryRun) {
  const { buildDag } = await import('./dag.js');
  const dagResult = await buildDag(hippoRoot, extractedFacts, {
    apiKey,
    model: config.extraction.model,
  });
  result.dagCandidateClusters = dagResult.candidateClusters;
  result.dagSummariesCreated = dagResult.summariesCreated;
} else {
  result.dagCandidateClusters = 0;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/consolidate-dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/dag.ts src/consolidate.ts tests/consolidate-dag.test.ts
git commit -m "feat: DAG construction during consolidation sleep cycle"
```

---

### Task 13: DAG-aware search — drill-down from summaries

When a query matches a DAG summary, also include the summary's child facts in the results. This lets search navigate the hierarchy: match the broad summary, then surface the specific facts beneath it.

**Files:**
- Modify: `src/search.ts` (add DAG drill-down after scoring)
- Modify: `src/store.ts` (add `loadChildEntries` function)
- Test: `tests/search-dag-drilldown.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/search-dag-drilldown.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

describe('DAG drill-down search', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dag-search-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('includes child facts when a DAG summary matches', () => {
    // Summary node
    const summary = createMemory(
      'John is a basketball player who trains daily and wants to improve his shooting percentage',
      { layer: Layer.Semantic, tags: ['dag-summary', 'speaker:John'], dag_level: 2 },
    );
    writeEntry(hippoRoot, summary);

    // Child facts (would not match "career goals" individually as well as the summary)
    const f1 = createMemory('John wants to improve his shooting percentage to lead the league', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    const f2 = createMemory('John dreams of winning a national championship', {
      layer: Layer.Semantic,
      tags: ['extracted', 'speaker:John'],
      dag_level: 1,
      dag_parent_id: summary.id,
    });
    writeEntry(hippoRoot, f1);
    writeEntry(hippoRoot, f2);

    const entries = loadAllEntries(hippoRoot);
    const results = search('John basketball career goals', entries, { budget: 4000 });

    // Should include the child facts, not just the summary
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain(f1.id);
    expect(ids).toContain(f2.id);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search-dag-drilldown.test.ts`
Expected: May PASS if children score well on their own, but the drill-down logic ensures they're included

**Step 3: Implement DAG drill-down**

In `src/search.ts`, after scoring and deduplication, add:

```typescript
// DAG drill-down: when a summary node matches, inject its children
const summaryIds = deduped
  .filter((r) => r.entry.tags.includes('dag-summary'))
  .map((r) => r.entry.id);

if (summaryIds.length > 0) {
  const childEntries = entries.filter(
    (e) => e.dag_parent_id && summaryIds.includes(e.dag_parent_id),
  );
  for (const child of childEntries) {
    if (!deduped.some((r) => r.entry.id === child.id)) {
      // Score the child using the parent's score as a baseline
      const parentResult = deduped.find((r) => r.entry.id === child.dag_parent_id);
      const childScore = parentResult ? parentResult.score * 0.9 : 0;
      deduped.push({
        entry: child,
        score: childScore,
        bm25: 0,
        cosine: 0,
        tokens: Math.ceil(child.content.length / 4),
      });
    }
  }
  // Re-sort after injection
  deduped.sort((a, b) => b.score - a.score);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search-dag-drilldown.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/search.ts tests/search-dag-drilldown.test.ts
git commit -m "feat: DAG-aware search with summary drill-down"
```

---

### Task 14: hippo dag command — inspect DAG structure

Add a CLI command to visualize the DAG: `hippo dag` shows the tree, `hippo dag --stats` shows counts per level.

**Files:**
- Modify: `src/cli.ts` (add cmdDag + dispatch case)
- Test: `tests/cli-dag.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/cli-dag.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

describe('hippo dag', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cli-dag-'));
    execSync(`hippo init --no-hooks --no-schedule --no-learn`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
    });
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('runs without error and shows dag stats', () => {
    const result = execSync(`hippo dag --stats`, {
      cwd: hippoRoot,
      env: { ...process.env, HIPPO_HOME: hippoRoot },
      encoding: 'utf-8',
    });
    expect(result).toContain('DAG');
  });
});
```

**Step 2-5: Implement, test, commit**

Standard TDD loop. The `cmdDag` function loads all entries, groups by dag_level, and displays:
```
DAG Structure:
  Level 3 (entity profiles): 0
  Level 2 (topic summaries): 5
  Level 1 (extracted facts): 47
  Level 0 (raw memories):    312
  Unlinked facts: 12
```

```bash
git add src/cli.ts tests/cli-dag.test.ts
git commit -m "feat: hippo dag command for DAG inspection"
```

---

## Phase 3: Multi-Hop Retrieval (v0.35)

**Why:** Single-pass retrieval can answer "What does John do?" but not "In which month did John achieve a career-high score and then get an endorsement deal?" — that requires chaining facts across topics and time.

**Target:** LoCoMo multi-hop 23% → 50-60%, overall 60-70% → 75%+.

**Prerequisite:** Phase 2 complete.

---

### Task 15: Multi-hop search — two-pass retrieval

First pass: retrieve top-K for the query. Second pass: extract entities from results, reformulate a follow-up query, retrieve again. Merge and re-rank.

**Files:**
- Create: `src/multihop.ts`
- Test: `tests/multihop.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/multihop.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { multihopSearch } from '../src/multihop.js';

describe('multihopSearch', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-multihop-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('chains retrieval to answer multi-hop questions', () => {
    // Fact 1: John scored 30 points (basketball context)
    writeEntry(hippoRoot, createMemory('John scored 30 points in the January 2024 game', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
    }));

    // Fact 2: January game was his career high (links to fact 1)
    writeEntry(hippoRoot, createMemory('John achieved a career-high score in the January 2024 game', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
    }));

    // Fact 3: endorsement (different topic, same entity)
    writeEntry(hippoRoot, createMemory('Nike offered John an endorsement deal in February 2024', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:endorsement'],
    }));

    // Unrelated noise
    writeEntry(hippoRoot, createMemory('Tim likes reading sci-fi novels', {
      layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim'],
    }));

    const entries = loadAllEntries(hippoRoot);
    const results = multihopSearch(
      'In which month did John achieve career-high and then get an endorsement?',
      entries,
      { budget: 4000 },
    );

    // Should find both the career-high AND the endorsement facts
    const contents = results.map((r) => r.entry.content);
    expect(contents.some((c) => c.includes('career-high'))).toBe(true);
    expect(contents.some((c) => c.includes('endorsement'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/multihop.test.ts`
Expected: FAIL — module not found

**Step 3: Implement multi-hop search**

```typescript
// src/multihop.ts
import type { MemoryEntry } from './memory.js';
import { search, type SearchResult } from './search.js';
import type { HybridSearchOptions } from './shared.js';

export function multihopSearch(
  query: string,
  entries: MemoryEntry[],
  options: HybridSearchOptions,
): SearchResult[] {
  // Pass 1: standard retrieval
  const pass1 = search(query, entries, { ...options, budget: (options.budget ?? 4000) * 2 });
  const topK = pass1.slice(0, 10);

  if (topK.length === 0) return [];

  // Extract entities from pass 1 results
  const entityTags = new Set<string>();
  for (const r of topK) {
    for (const tag of r.entry.tags) {
      if (tag.startsWith('speaker:') || tag.startsWith('topic:')) {
        entityTags.add(tag);
      }
    }
  }

  // Build follow-up query from entities not in original query
  const queryLower = query.toLowerCase();
  const newEntities = [...entityTags]
    .map((t) => t.split(':')[1])
    .filter((e) => !queryLower.includes(e.toLowerCase()));

  if (newEntities.length === 0) return pass1;

  // Pass 2: retrieve by discovered entities
  const followUpQuery = newEntities.join(' ') + ' ' + query;
  const pass2 = search(followUpQuery, entries, options);

  // Merge: deduplicate by ID, keep higher score
  const merged = new Map<string, SearchResult>();
  for (const r of [...pass1, ...pass2]) {
    const existing = merged.get(r.entry.id);
    if (!existing || r.score > existing.score) {
      merged.set(r.entry.id, r);
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/multihop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/multihop.ts tests/multihop.test.ts
git commit -m "feat: multi-hop search with two-pass entity-chained retrieval"
```

---

### Task 16: Wire multi-hop into hippo recall

Add `--multihop` flag to `hippo recall` to use the chained retrieval strategy.

**Files:**
- Modify: `src/cli.ts` (cmdRecall)
- Modify: `src/config.ts` (add multihop config)
- Test: `tests/cli-multihop.test.ts`

**Step 1-5: Standard TDD loop**

Parse `--multihop` flag in cmdRecall. When set, call `multihopSearch` instead of `hybridSearch`/`search`.

Config addition:
```typescript
multihop: {
  enabled: boolean;  // default false — opt-in
};
```

CLI usage: `hippo recall "complex question" --multihop`

```bash
git add src/cli.ts src/config.ts tests/cli-multihop.test.ts
git commit -m "feat: hippo recall --multihop flag for chained retrieval"
```

---

### Task 17: Temporal-aware retrieval

Add temporal ordering awareness to search. When a query contains temporal cues ("before", "after", "recently", "first", "last"), boost memories whose timestamps match the temporal direction.

**Files:**
- Modify: `src/search.ts` (add temporal boost in scoring)
- Test: `tests/search-temporal.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/search-temporal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { search } from '../src/search.js';

describe('temporal-aware search', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-temporal-'));
    initStore(hippoRoot);
  });

  afterEach(() => {
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('boosts recent memories for "recently" queries', () => {
    const old = createMemory('Tim read Dune in January 2023', {
      layer: Layer.Semantic, tags: ['extracted'],
    });
    // Manually set older created date
    (old as any).created = '2023-01-15T00:00:00Z';
    writeEntry(hippoRoot, old);

    const recent = createMemory('Tim read Project Hail Mary in March 2024', {
      layer: Layer.Semantic, tags: ['extracted'],
    });
    (recent as any).created = '2024-03-01T00:00:00Z';
    writeEntry(hippoRoot, recent);

    const entries = loadAllEntries(hippoRoot);
    const results = search('What has Tim read recently?', entries, { budget: 4000 });

    // Recent book should rank first
    expect(results[0].entry.content).toContain('Project Hail Mary');
  });
});
```

**Step 2-5: Standard TDD loop**

Detect temporal keywords in query. Apply a temporal direction multiplier:
- "recently", "latest", "last", "newest" → boost recent (recency multiplier × 1.5)
- "first", "earliest", "originally", "initially" → boost oldest (invert recency boost)
- "before X", "after X" → date-relative filtering (future enhancement)

```bash
git add src/search.ts tests/search-temporal.test.ts
git commit -m "feat: temporal-aware search scoring for time-oriented queries"
```

---

### Task 18: Final LoCoMo benchmark — full pipeline validation

Run the complete LoCoMo benchmark with extraction + DAG + multi-hop enabled. Compare against v0.32.0 baseline and competitor scores.

**Files:**
- Modify: `benchmarks/locomo/run.py` (enable multihop recall, add sleep between ingestion and scoring)

**Step 1: Update harness**

```python
def hippo_recall(hippo_home, query, budget=4000):
    # Use multihop for all queries
    result = run_hippo(
        ["recall", query, "--json", "--budget", str(budget), "--multihop"],
        ...
    )
```

Add a `hippo sleep` call after ingesting all turns (to trigger extraction + DAG building):

```python
# After ingestion, run sleep to build DAG
run_hippo(["sleep"], cwd=hippo_home, hippo_home=hippo_home, timeout=300)
```

**Step 2: Run full benchmark**

```bash
cd benchmarks/locomo
ANTHROPIC_API_KEY=<key> nohup python run.py \
  --data data/locomo10.json \
  --output-dir results/ \
  --output-name hippo-v0.35.0-full.json \
  --verbose > results/run-v0.35.0.log 2>&1 &
```

**Step 3: Analyze results**

```bash
python finalize.py \
  results/hippo-v0.35.0-full.json \
  results/hippo-v0.33.0-extract.json \
  results/hippo-v0.32.0.json
```

Expected target scores:
| Category | v0.32 | v0.33 target | v0.35 target |
|----------|-------|--------------|--------------|
| single-hop | 18% | 45% | 65% |
| multi-hop | 23% | 30% | 55% |
| temporal | 16% | 25% | 45% |
| open-domain | 18% | 40% | 55% |
| adversarial | 27% | 50% | 65% |
| **overall** | **20%** | **40%** | **60%** |

**Step 4: Commit**

```bash
git add benchmarks/locomo/run.py
git commit -m "bench: full pipeline benchmark with extraction + DAG + multihop"
```

---

## Summary

| Phase | Version | Key Feature | Files Created | Files Modified | Tests |
|-------|---------|-------------|---------------|----------------|-------|
| 1 | v0.33 | Write-time extraction | extract.ts | db.ts, memory.ts, store.ts, config.ts, cli.ts, search.ts, consolidate.ts | 7 |
| 2 | v0.34 | DAG summarization | dag.ts | db.ts, memory.ts, store.ts, consolidate.ts, search.ts, cli.ts | 5 |
| 3 | v0.35 | Multi-hop retrieval | multihop.ts | search.ts, cli.ts, config.ts | 3 |

**Total:** 3 new modules, ~15 modified files, ~15 test files, ~18 commits.

**Critical path:** Task 1 → 2 → 3 → 4 → 5 → 8 (Phase 1 MVP with benchmark). Phase 2 and 3 can overlap in development.

**Risk:** LLM extraction adds latency (~1-2s per fact at write time) and cost (~$0.001/turn for claude-sonnet-4-6). Mitigated by: opt-in flag, batch extraction during sleep, capping at 20 extractions per sleep cycle.

**Non-negotiables:**
- Bio-inspired mechanics (decay, retrieval strengthening, consolidation) apply to ALL memory types including extracted facts
- Extraction is always opt-in or best-effort (never blocks remember)
- Raw memories are always preserved (extraction creates new entries, doesn't modify originals)
- No new external dependencies beyond the existing Anthropic API pattern from refine-llm.ts
