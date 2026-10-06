// Each best-effort catch around a hippo.db open on a recall path rethrows SqliteBlockedError, so an unported path under
// another store answers 501 instead of falling back quietly; any other error keeps the catch's fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBlockedError, withSqliteBlocked } from '../src/db.js';
import { recordTokens } from '../src/api.js';
import { recordMcpTokens } from '../src/mcp/request.js';
import { strengthenRetrieved } from '../src/store/entry-writes.js';
import { writeRecallTraceAtRoot } from '../src/recall-trace.js';
import { resolveIndexedEmbeddingModel } from '../src/embeddings.js';
import { resolveVectorArm } from '../src/search/vector.js';
import { physicsSearch } from '../src/search/physics-search.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';

const entry = createMemory('deploy pipeline notes for the api', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });

const ranked = (results: readonly unknown[]): string => `ranked ${results.length}`;

/** [catch site, a frame the blocked error's stack must name, the call, what the call returns when the open fails otherwise]. */
type Row = readonly [string, RegExp, (root: string) => Promise<string>, string];

const ROWS: readonly Row[] = [
  ['api/tokens.ts recordTokens', /recordTokens/, async (root) => {
    await recordTokens({ hippoRoot: root, tenantId: 'default', actor: { subject: 'test', role: 'admin' } }, 'http_recall', { items: 1, tokens: 1 });
    return 'returned';
  }, 'returned'],
  ['mcp/request.ts recordMcpTokens', /recordMcpTokens/, async (root) => {
    await recordMcpTokens('hippo_context', 'memory text', { hippoRoot: root, tenantId: 'default', actor: 'mcp' });
    return 'returned';
  }, 'returned'],
  ['store/entry-writes.ts strengthenRetrieved', /strengthenRetrieved/,
    async (root) => `found ${strengthenRetrieved(root, [entry.id], { recallBoostAblated: false }).size}`, 'found 0'],
  ['recall-trace.ts writeRecallTraceAtRoot', /writeRecallTraceAtRoot/, async (root) => String(writeRecallTraceAtRoot(root, {
    tenantId: 'default', sessionId: null, pipeline: 'mcp', query: 'deploy', results: [],
  })), 'null'],
  ['embeddings.ts loadStoredEmbeddingModel', /loadStoredEmbeddingModel/, async (root) => String(resolveIndexedEmbeddingModel(root, {})), 'null'],
  ['search/vector.ts resolveVectorArm', /fillVectorArm/,
    async (root) => `embeddings ${(await resolveVectorArm('deploy', [], { hippoRoot: root })).useEmbeddings}`, 'embeddings false'],
  ['search/physics-search.ts physicsQueryVector', /physicsQueryVector/,
    async (root) => ranked(await physicsSearch('deploy', [entry], { hippoRoot: root })), 'ranked 1'],
  ['search/physics-search.ts withVectorCandidates', /withVectorCandidates/, async (root) => ranked(await physicsSearch('deploy', [entry], {
    hippoRoot: root, queryEmbedding: [1, 0, 0], vectorCandidates: { includeSuperseded: false },
  })), 'ranked 1'],
  ['search/physics-search.ts loadCandidateParticles', /loadCandidateParticles/,
    async (root) => ranked(await physicsSearch('deploy', [entry], { hippoRoot: root, queryEmbedding: [1, 0, 0] })), 'ranked 1'],
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-blocked-catch-'));
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  // An API provider with a stubbed fetch, so the vector arm and physics reach their opens without a local model or the network.
  writeFileSync(join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'text-embedding-3-small' } }), 'utf8');
  vi.stubEnv('OPENAI_API_KEY', randomBytes(16).toString('hex'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }))));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('best-effort catches around a hippo.db open', () => {
  it.each(ROWS)('%s rethrows SqliteBlockedError under another store', async (_site, reach, run) => {
    const err = await withSqliteBlocked('stub', () => run(root)).then(() => null, <E>(e: E) => e);
    expect(err).toBeInstanceOf(SqliteBlockedError);
    expect(err instanceof Error ? err.stack : '').toMatch(reach);
  });

  it.each(ROWS)('%s keeps its fallback when the open fails for another reason', async (_site, _reach, run, fallback) => {
    mkdirSync(join(root, 'hippo.db'));
    expect(await run(root)).toBe(fallback);
  });
});
