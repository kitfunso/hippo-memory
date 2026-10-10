// Pins which memories MCP hippo_recall returns, and in what order, across its modes and arguments.
// Ids are random per seed, so rows are named by label.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, type CreateMemoryOptions, type MemoryEntry } from '../src/core/memory.js';
import { handleMcpRequest, _resetSessionRecallHistoryMcpForTests, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { pushGoal } from '../src/store/goals.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveStoredEmbeddingModel } from '../src/store/embeddings/index.js';
import { saveEmbeddingIndex } from '../src/store/vector-index.js';
import { resolveEmbeddingProvider } from '../src/store/embeddings/provider.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { openHippoDb, closeHippoDb, withSharedStoreHandles } from '../src/db/index.js';

// Every case seeds 26 rows, two of them up to 210 more, in a real store, so its time follows the runner's disk.
vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-09-01T12:00:00.000Z';
const TENANT = 'default';
const QUERY = 'deploy pipeline';

interface Seeded {
  home: string;
  labelById: Map<string, string>;
  idByLabel: Map<string, string>;
  contentByLabel: Map<string, string>;
}

interface StoreConfig {
  embeddings?: { provider: string; model: string };
  physics?: { enabled: boolean };
}

function makeHome(config?: StoreConfig): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mcp-ranking-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config), 'utf8');
  initStore(home);
  return home;
}

function add(s: Seeded, label: string, content: string, opts: Partial<CreateMemoryOptions> = {}): MemoryEntry {
  const entry = createMemory(content, { baseHalfLifeDays: 7, tenantId: TENANT, ...opts });
  writeEntry(s.home, entry);
  s.labelById.set(entry.id, label);
  s.idByLabel.set(label, entry.id);
  s.contentByLabel.set(label, content);
  return entry;
}

/** Lexical hits of differing strength, a semantic-only row, scoped, private, legacy, pinned and churn-stale rows, and noise. */
function seed(config?: StoreConfig): Seeded {
  const s: Seeded = { home: makeHome(config), labelById: new Map(), idByLabel: new Map(), contentByLabel: new Map() };
  add(s, 'L1', 'deploy pipeline uses blue green rollout');
  add(s, 'L2', 'deploy checklist says run migrations before every deploy');
  add(s, 'L3', 'rollback the deploy when health checks fail twice');
  add(s, 'L4', 'pipeline caching speeds up the nightly builds');
  add(s, 'L5', 'the pipeline owner reviews flaky stages weekly and files tickets for each one');
  add(s, 'S1', 'ship to production with zero downtime');
  add(s, 'D1', 'decision: freeze deploy on fridays', { tags: ['decision'] });
  add(s, 'P1', 'deploy keys are rotated monthly', { pinned: true });
  add(s, 'C1', 'stale deploy pipeline note from the old cluster', { tags: ['churn-stale'] });
  add(s, 'G1', 'goal work notes mention the pipeline once among many other unrelated words here', { tags: ['ship-goal'] });
  add(s, 'SC1', 'deploy pipeline for team alpha only', { scope: 'team:alpha' });
  add(s, 'SC2', 'team alpha pipeline secrets live in vault', { scope: 'team:alpha' });
  add(s, 'PR1', 'deploy pipeline private channel notes', { scope: 'slack:private:c1' });
  add(s, 'LG1', 'deploy pipeline legacy quarantined row', { scope: 'unknown:legacy' });
  for (let i = 0; i < 12; i++) add(s, `N${i}`, `unrelated noise row number ${i} about lunch menus`);
  return s;
}

function call(home: string, args: Record<string, string | number | boolean>, ctx?: Partial<McpContext>): Promise<McpResponse | null> {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: args } },
    { hippoRoot: home, tenantId: TENANT, actor: 'mcp', ...ctx },
  );
}

function textOf(res: McpResponse | null): string {
  // SAFETY: hippo_recall's success envelope is written by src/mcp/server.ts as { content: [{ text }] }.
  return (res?.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text ?? '';
}

interface Observed {
  ranked: string[];
  tail: string[];
  cutoff: string | null;
}

/** Labels of the ranked list in print order, labels of the tail section, and the Cutoff line. */
function observe(s: Seeded, text: string): Observed {
  const start = text.indexOf('Found ');
  const tailAt = text.indexOf('## Fresh tail / substituted summaries');
  const contAt = text.indexOf('## Continuity');
  const ends = [tailAt, contAt].filter((i) => i > start);
  const list = start < 0 ? '' : text.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
  const ranked = [...s.contentByLabel.entries()]
    .map(([label, content]) => ({ label, at: list.indexOf(`\n${content}\n`) }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((r) => r.label);
  const tail = tailAt < 0
    ? []
    : [...text.slice(tailAt).matchAll(/^- \[(?:tail|summary)\] (\S+?)(?: \(covers \d+ rows\))?:/gm)].map((m) => s.labelById.get(m[1]) ?? m[1]);
  const cutoff = /^Showing .*$/m.exec(text)?.[0] ?? null;
  return { ranked, tail, cutoff };
}

/** Label to retrieval_count for every row retrieved at least once. */
function retrievalCounts(s: Seeded): Map<string, number> {
  const db = openHippoDb(s.home);
  try {
    // SAFETY: the SELECT names exactly the two columns read below.
    const rows = db.prepare('SELECT id, retrieval_count FROM memories').all() as Array<{ id: string; retrieval_count: number }>;
    return new Map(rows.filter((r) => r.retrieval_count > 0).map((r) => [s.labelById.get(r.id) ?? r.id, r.retrieval_count]));
  } finally {
    closeHippoDb(db);
  }
}

/** Query vector points at S1; lexical hits sit at cosine 0.6; noise is orthogonal. */
function withEmbeddings(s: Seeded): void {
  const id = resolveEmbeddingProvider(s.home).id;
  const index: Record<string, number[]> = {};
  for (const [label, memId] of s.idByLabel) {
    index[memId] = label === 'S1' ? [1, 0, 0] : label.startsWith('N') ? [0, 0, 1] : [0.6, 0.8, 0];
  }
  saveEmbeddingIndex(s.home, index);
  saveStoredEmbeddingModel(s.home, id);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    // SAFETY: body is the OpenAI embeddings request this provider just serialised.
    const body = JSON.parse(init.body) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0] })) }), { status: 200 });
  }));
}

const EMBED_CONFIG = { embeddings: { provider: 'openai', model: 'text-embedding-3-small' } };

describe('MCP hippo_recall ranking', () => {
  const homes: string[] = [];
  const track = (s: Seeded): Seeded => { homes.push(s.home); return s; };

  beforeEach(() => {
    process.env.HIPPO_FAKE_NOW = NOW;
    _resetAblationCacheForTests();
    _resetSessionRecallHistoryMcpForTests();
  });

  afterEach(() => {
    delete process.env.HIPPO_FAKE_NOW;
    delete process.env.OPENAI_API_KEY;
    _resetAblationCacheForTests();
    vi.unstubAllGlobals();
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  it('default hybrid mode, default budget', async () => {
    const s = track(seed());
    expect(observe(s, textOf(await call(s.home, { query: QUERY })))).toEqual(EXPECTED.defaultHybrid);
  });

  it('a tight budget keeps only the top rows', async () => {
    const s = track(seed());
    expect(observe(s, textOf(await call(s.home, { query: QUERY, budget: 90 })))).toEqual(EXPECTED.tightBudget);
  });

  it('an explicit scope returns that scope only', async () => {
    const s = track(seed());
    expect(observe(s, textOf(await call(s.home, { query: QUERY, scope: 'team:alpha' })))).toEqual(EXPECTED.explicitScope);
  });

  it('include_continuity appends the continuity block after the list and pays for it from the budget', async () => {
    const s = track(seed());
    saveActiveTaskSnapshot(s.home, 'default', { task: 'Ship the deploy pipeline', summary: 'blue green rollout in flight', next_step: 'flip traffic', session_id: 'sess-x', source: 'test' });
    appendSessionEvent(s.home, 'default', { session_id: 'sess-x', event_type: 'note', content: 'rollout paused at 50 percent', source: 'test' });
    const args = { query: QUERY, budget: 250 };
    expect(observe(s, textOf(await call(s.home, args))).ranked).toEqual(EXPECTED.defaultHybrid.ranked);
    const text = textOf(await call(s.home, { ...args, include_continuity: true }));
    expect(text.indexOf('## Continuity')).toBeGreaterThan(text.indexOf('Found '));
    expect(observe(s, text)).toEqual(EXPECTED.continuity);
  });

  it('physics mode without embeddings ranks like hybrid, a short exact match first', async () => {
    const s = track(seed({ physics: { enabled: true } }));
    add(s, 'X1', 'deploy pipeline');
    expect(observe(s, textOf(await call(s.home, { query: QUERY })))).toEqual(EXPECTED.physicsNoEmbeddings);
  });

  it('hybrid mode with embeddings returns the semantic-only row', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const s = track(seed(EMBED_CONFIG));
    withEmbeddings(s);
    expect(observe(s, textOf(await call(s.home, { query: QUERY })))).toEqual(EXPECTED.hybridEmbeddings);
  });

  it('physics mode with embeddings returns the semantic-only row', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const s = track(seed({ ...EMBED_CONFIG, physics: { enabled: true } }));
    withEmbeddings(s);
    expect(observe(s, textOf(await call(s.home, { query: QUERY })))).toEqual(EXPECTED.physicsEmbeddings);
  });

  it('session goals boost by score, not by position', async () => {
    const s = track(seed());
    pushGoal(s.home, { sessionId: 'sess-rank', tenantId: TENANT, goalName: 'ship-goal' });
    expect(observe(s, textOf(await call(s.home, { query: QUERY, session_id: 'sess-rank' })))).toEqual(EXPECTED.goalBoost);
  });

  it('fresh tail and scorer_window: tail rows follow the list, and only the listed rows are strengthened', async () => {
    const s = track(seed());
    for (const n of ['one', 'two', 'three']) add(s, `T-${n}`, `standup chatter ${n}`, { layer: Layer.Buffer, kind: 'raw' });
    const seen = observe(s, textOf(await call(s.home, { query: QUERY, scorer_window: 2, fresh_tail_count: 3 })));
    expect(seen).toEqual(EXPECTED.freshTail);
    expect(retrievalCounts(s)).toEqual(new Map(seen.ranked.map((l) => [l, 1])));
  });

  it('a strong match outside the 200-row lexical window still ranks', async () => {
    const s = track(seed());
    add(s, 'W1', 'alpha important decision record', { tags: ['decision', 'extracted'] });
    // One connection for the seed loop: a close per write checkpoints the WAL, which is slow on Windows.
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 210; i++) add(s, `F${i}`, `alpha note ${i}`);
    });
    expect(observe(s, textOf(await call(s.home, { query: 'alpha', budget: 300 })))).toEqual(EXPECTED.windowEdge);
  });

  it('overflowed children of a level-2 summary bring the summary into the tail', async () => {
    const s = track(seed());
    const parent = add(s, 'SUM', 'rollup summary of the child notes', { dag_level: 2, tags: ['dag-summary'] });
    // One connection for the seed loop: a close per write checkpoints the WAL, which is slow on Windows.
    await withSharedStoreHandles(() => {
      for (let i = 0; i < 3; i++) add(s, `K${i}`, `beta zz child ${i}`, { dag_level: 0, dag_parent_id: parent.id });
      for (let i = 0; i < 60; i++) add(s, `B${i}`, `beta row ${i}`);
    });
    expect(observe(s, textOf(await call(s.home, { query: 'beta', budget: 200 })))).toEqual(EXPECTED.dagOverflow);
  });

  it('strengthens each shown row once and traces the shown list as pipeline mcp', async () => {
    const s = track(seed());
    const seen = observe(s, textOf(await call(s.home, { query: QUERY, session_id: 'sess-trace' })));
    expect(retrievalCounts(s)).toEqual(new Map(seen.ranked.map((l) => [l, 1])));
    const db = openHippoDb(s.home);
    try {
      // SAFETY: each SELECT names exactly the columns read below.
      const traces = db.prepare('SELECT id, pipeline, session_id, result_count FROM recall_traces').all() as Array<{ id: number; pipeline: string; session_id: string; result_count: number }>;
      expect(traces).toEqual([{ id: traces[0]?.id, pipeline: 'mcp', session_id: 'sess-trace', result_count: seen.ranked.length }]);
      // SAFETY: the SELECT names the one column read below.
      const rows = db.prepare('SELECT memory_id FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank').all(traces[0]?.id) as Array<{ memory_id: string }>;
      expect(rows.map((r) => s.labelById.get(r.memory_id))).toEqual(seen.ranked);
    } finally {
      closeHippoDb(db);
    }
  });
});

// Candidates are a wide FTS window plus the nearest vectors, so Cutoff counts only rows that matched the query.
const EXPECTED = {
  defaultHybrid: {
    ranked: ['SC1', 'L1', 'L2', 'D1', 'P1', 'L4', 'SC2', 'L3', 'C1', 'L5', 'G1'],
    tail: [],
    cutoff: null,
  },
  tightBudget: {
    ranked: ['SC1', 'L1', 'L2'],
    tail: [],
    cutoff: 'Showing 3 of 11 candidates; 8 dropped to fit limit.',
  },
  explicitScope: {
    ranked: ['SC1', 'SC2'],
    tail: [],
    cutoff: null,
  },
  continuity: {
    ranked: ['SC1', 'L1', 'L2', 'D1', 'P1', 'L4', 'SC2', 'L3', 'C1'],
    tail: [],
    cutoff: 'Showing 9 of 11 candidates; 2 dropped to fit limit.',
  },
  physicsNoEmbeddings: {
    ranked: ['X1', 'SC1', 'L1', 'L2', 'D1', 'P1', 'L4', 'SC2', 'L3', 'C1', 'L5', 'G1'],
    tail: [],
    cutoff: null,
  },
  hybridEmbeddings: {
    ranked: ['SC1', 'L1', 'S1', 'D1', 'L2', 'P1', 'L4', 'SC2', 'L3', 'L5', 'G1', 'C1'],
    tail: [],
    cutoff: null,
  },
  physicsEmbeddings: {
    ranked: ['SC1', 'L1', 'D1', 'L2', 'S1', 'P1', 'L4', 'SC2', 'L3', 'L5', 'G1', 'C1'],
    tail: [],
    cutoff: null,
  },
  goalBoost: {
    ranked: ['SC1', 'L1', 'G1', 'L2', 'D1', 'P1', 'L4', 'SC2', 'L3', 'C1', 'L5'],
    tail: [],
    cutoff: null,
  },
  freshTail: {
    ranked: ['SC1', 'L1', 'L2', 'D1', 'P1', 'L4', 'SC2', 'L3', 'C1', 'L5', 'G1'],
    tail: ['T-one', 'T-three', 'T-two'],
    cutoff: 'Showing 11 of 11 candidates; 3 fresh-tail added.',
  },
  windowEdge: {
    ranked: ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'W1', 'F10', 'F100', 'F101', 'F102', 'F103', 'F104', 'F105', 'F106', 'F107', 'F108', 'F109', 'F11', 'F110', 'F111'],
    tail: [],
    cutoff: 'Showing 25 of 213 candidates; 188 dropped to fit limit.',
  },
  dagOverflow: {
    ranked: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13'],
    tail: ['SUM'],
    cutoff: 'Showing 14 of 63 candidates; 49 dropped to fit limit; 1 summary substitutions added.',
  },
} satisfies Record<string, Observed>;
