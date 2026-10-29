// The whole reply of each recall surface (HTTP GET /v1/memories JSON, MCP hippo_recall text, CLI `hippo recall --json`)
// and every row the recall writes, over one seeded store with vectors, pinned byte for byte: a ranking change on any
// surface moves this snapshot, while recall-surface-differences.server.test.ts names which difference it touched.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { handleRecall } from '../../src/surface/cli/recall.js';
import { handleMcpRequest, type McpResponse } from '../../src/surface/mcp/server.js';
import { serve } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createCallerState, type CallerState } from '../../src/api/callers.js';
import type { CliFlags } from '../../src/surface/cli/flag-values.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { testInfra } from '../_helpers/infra.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { seedVectors } from '../_helpers/recall-vector-seed.js';
import {
  CLEARED_ENV,
  FAKE_NOW,
  freshStore,
  normalize,
  rowsOf,
  SESSION,
  seedTemplates,
  TENANT,
  type Store,
  type Templates,
} from '../_helpers/recall-golden-seed.js';
import { mcpContext } from '../_helpers/mcp-context.js';

type ToolArgs = Record<string, string | number | boolean>;

/** One query and the arguments each surface takes for it; a surface without the argument gets none. */
interface SnapshotCase {
  readonly query: string;
  readonly http?: Readonly<Record<string, string>>;
  readonly mcp?: Readonly<ToolArgs>;
  readonly cli?: Readonly<CliFlags>;
}

const SESSION_HTTP = { session_id: SESSION };
const SESSION_MCP = { session_id: SESSION };
const SESSION_CLI = { 'session-id': SESSION };

const CASES: ReadonlyArray<readonly [string, SnapshotCase]> = [
  ['one word', { query: 'deploy', cli: { why: true } }],
  ['many words', { query: 'deploy rollout to the new staging cluster' }],
  ['part word', { query: 'caf' }],
  ['no terms', { query: '!!' }],
  ['no match', { query: 'zebra' }],
  [
    'scope filter',
    { query: 'deploy', http: { scope: 'team-alpha' }, mcp: { scope: 'team-alpha' }, cli: { scope: 'team-alpha' } },
  ],
  ['goal session', { query: 'deploy', http: SESSION_HTTP, mcp: SESSION_MCP, cli: SESSION_CLI }],
  ['hybrid mode', { query: 'deploy rollout', http: { mode: 'hybrid' }, mcp: { mode: 'hybrid' } }],
  [
    'hybrid mode with a goal session',
    {
      query: 'deploy',
      http: { mode: 'hybrid', ...SESSION_HTTP },
      mcp: { mode: 'hybrid', ...SESSION_MCP },
      cli: { why: true, ...SESSION_CLI },
    },
  ],
  ['limit', { query: 'deploy', http: { limit: '3' }, mcp: { limit: 3 }, cli: { limit: '3' } }],
  ['budget', { query: 'deploy', mcp: { budget: 120 }, cli: { budget: '120' } }],
  ['forward claim', { query: 'the deploy will take 3 days' }],
  [
    'continuity and fresh tail',
    {
      query: 'deploy',
      http: { include_continuity: 'true', fresh_tail_count: '1', fresh_tail_session_id: SESSION, ...SESSION_HTTP },
      mcp: { include_continuity: true, fresh_tail_count: 1, fresh_tail_session_id: SESSION, ...SESSION_MCP },
      cli: { continuity: true, ...SESSION_CLI },
    },
  ],
  [
    'scorer window and summaries',
    { query: 'deploy', http: { scorer_window: '5', limit: '2' }, mcp: { scorer_window: 5 }, cli: { limit: '2' } },
  ],
];

let templates: Templates;
let embeddings: HashedEmbeddings;
let callers: CallerState;

// The seeded prediction's claim is a semantic row with a fresh id each run.
const stableIds = <T>(value: T): T =>
  // SAFETY: only string contents change, so the JSON parses back to the same shape.
  JSON.parse(JSON.stringify(value).replace(/\bsem_[0-9a-f]+\b/g, '<claim>')) as T;

/** What one recall answered and every row it left in the local and the global store. */
interface Recalled<T> {
  readonly reply: T;
  readonly local: ReturnType<typeof rowsOf>;
  readonly global: ReturnType<typeof rowsOf>;
}

async function onFreshStore<T>(answer: (s: Store) => Promise<T>): Promise<Recalled<T>> {
  const s = freshStore(templates, 'local');
  try {
    const reply = await answer(s);
    return stableIds(normalize({ reply, local: rowsOf(s.root), global: rowsOf(s.globalRoot) }, s));
  } finally {
    rmSync(s.home, { recursive: true, force: true });
  }
}

interface HttpReply {
  readonly status: number;
  readonly body: string;
}

async function viaHttp(s: Store, c: SnapshotCase): Promise<HttpReply> {
  const handle = await serveKeyed({ hippoRoot: s.root, port: 0 }, serve);
  try {
    const params = new URLSearchParams({ q: c.query, ...c.http });
    const res = await fetch(`${handle.url}/v1/memories?${params.toString()}`);
    return { status: res.status, body: await res.text() };
  } finally {
    await handle.stop();
  }
}

function viaMcp(s: Store, c: SnapshotCase): Promise<McpResponse | null> {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'hippo_recall', arguments: { query: c.query, ...c.mcp } },
    },
    mcpContext({
      hippoRoot: s.root,
      tenantId: TENANT,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: sqliteStore(s.root),
      config: loadConfig(s.root),
      infra: testInfra(),
      callers,
    }),
  );
}

function viaCli(s: Store, c: SnapshotCase): Promise<InProcessResult> {
  const flags: CliFlags = { json: true, ...c.cli };
  return runInProcess((cli) =>
    handleRecall({ cli, hippoRoot: s.root, tenantId: TENANT, args: [c.query], flags, callers }),
  );
}

const SURFACES = { http: viaHttp, mcp: viaMcp, cli: viaCli };
const SURFACE_NAMES = ['http', 'mcp', 'cli'] as const;
const CASE_SURFACES = CASES.flatMap(([name, c]) => SURFACE_NAMES.map((surface) => [name, surface, c] as const));
const fileStem = (name: string): string => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

describe('recall surface snapshot', () => {
  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
    templates = await seedTemplates(async (root) => await seedVectors(root, embeddings.url));
  });

  afterAll(async () => {
    await embeddings.close();
    rmSync(templates.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    callers = createCallerState();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A store per surface: a recall rewrites the rows it returns, and that write would move the next surface's ranks.
  // One file per case and surface, so a moved ranking shows as a small diff in the one place it moved.
  it.each(CASE_SURFACES)('%s via %s', async (name, surface, c) => {
    const got = await onFreshStore<unknown>((s) => SURFACES[surface](s, c));
    await expect(got).toMatchFileSnapshot(`./__snapshots__/recall-surface/${fileStem(name)}.${surface}.txt`);
  });
});
