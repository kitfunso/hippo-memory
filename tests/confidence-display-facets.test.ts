// The stored confidence tier and the derived age-out are two facts that
// `resolveConfidence` fused into one, making a rejected row and an aged-out
// one indistinguishable at every display site.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, confidenceFacets, resolveConfidence, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { serveDashboard } from '../src/dashboard/dashboard.js';
import { boundPort } from './_helpers/listen.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { _resetAblationCacheForTests } from '../src/core/ablation.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { runCli } from '../src/cli.js';
import { withHookStdin } from './_helpers/hook-stdin.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { makeStore } from './_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const DASHBOARD_TOKEN = 'test-dashboard-token';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const DAY = 86_400_000;

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function seed(
  root: string,
  content: string,
  over: Partial<MemoryEntry> = {},
): MemoryEntry {
  const e = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['facets'] }), ...over };
  writeEntry(root, e);
  return e;
}

/** `hippo <args>` run in this process from `cwd` with an empty hook stdin, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function hippo(cwd: string, args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => withHookStdin(undefined, () => runCli(['node', 'hippo', ...args])));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

function get(port: number, path: string): Promise<string> {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { cookie: `hippo_dashboard_${port}=${DASHBOARD_TOKEN}` } }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { body += c; });
      r.on('end', () => res(body));
    });
    req.on('error', rej);
    req.end();
  });
}

describe('confidence facets', () => {
  let home: string;
  let hippoRoot: string;
  let server: Server | undefined;

  beforeEach(() => {
    ({ base: home, root: hippoRoot } = makeStore('facets'));
    vi.stubEnv('HIPPO_HOME', join(home, '.hippo-global'));
    vi.stubEnv('HIPPO_FAKE_NOW', NOW.toISOString());
    _resetAblationCacheForTests();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res, rej) => server!.close((e) => (e ? rej(e) : res())));
      server = undefined;
    }
    _resetAblationCacheForTests();
  });

  it('splits an aged-out observed row into tier and agedOut', () => {
    const e = seed(hippoRoot, 'an observed row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    expect(confidenceFacets(e, NOW)).toEqual({ tier: 'observed', agedOut: true });
  });

  it('reports a freshly rejected row as stale and not aged out', () => {
    const e = seed(hippoRoot, 'a row a human rejected through hippo invalidate', {
      confidence: 'stale',
      last_retrieved: ago(1),
    });
    expect(confidenceFacets(e, NOW)).toEqual({ tier: 'stale', agedOut: false });
  });

  it('reports a row that is both rejected and old as stale and aged out', () => {
    const e = seed(hippoRoot, 'a rejected row nobody has retrieved since', {
      confidence: 'stale',
      last_retrieved: ago(400),
    });
    expect(confidenceFacets(e, NOW)).toEqual({ tier: 'stale', agedOut: true });
  });

  it('leaves resolveConfidence behaviour unchanged across every shape', () => {
    const cases: Array<[Partial<MemoryEntry>, string]> = [
      [{ confidence: 'observed', last_retrieved: ago(45) }, 'stale'],
      [{ confidence: 'observed', last_retrieved: ago(1) }, 'observed'],
      [{ confidence: 'inferred', last_retrieved: ago(45) }, 'stale'],
      [{ confidence: 'stale', last_retrieved: ago(1) }, 'stale'],
      [{ confidence: 'verified', last_retrieved: ago(999) }, 'verified'],
      [{ confidence: 'observed', last_retrieved: ago(999), pinned: true }, 'observed'],
    ];
    for (const [over, want] of cases) {
      const e = seed(hippoRoot, `shape ${want} ${JSON.stringify(over)}`, over);
      expect(resolveConfidence(e, NOW)).toBe(want);
    }
  });

  it('ages out one millisecond past thirty days, not at thirty days', () => {
    const at = seed(hippoRoot, 'a row retrieved exactly thirty days ago', {
      confidence: 'observed',
      last_retrieved: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    });
    const past = seed(hippoRoot, 'a row retrieved a millisecond earlier than that', {
      confidence: 'observed',
      last_retrieved: new Date(NOW.getTime() - 30 * DAY - 1).toISOString(),
    });
    expect(confidenceFacets(at, NOW).agedOut).toBe(false);
    expect(confidenceFacets(past, NOW).agedOut).toBe(true);
  });

  it('ages out a row never retrieved since it was created', () => {
    const e = seed(hippoRoot, 'a row written once and never recalled again', {
      confidence: 'observed',
      created: ago(60),
      last_retrieved: ago(60),
      retrieval_count: 0,
    });
    expect(confidenceFacets(e, NOW).agedOut).toBe(true);
  });

  it('exempts pinned and verified rows from ageing however old they are', () => {
    const pinned = seed(hippoRoot, 'a pinned rule untouched for a year', {
      confidence: 'observed',
      pinned: true,
      last_retrieved: ago(365),
    });
    const verified = seed(hippoRoot, 'a verified fact untouched for a year', {
      confidence: 'verified',
      last_retrieved: ago(365),
    });
    expect(confidenceFacets(pinned, NOW).agedOut).toBe(false);
    expect(confidenceFacets(verified, NOW).agedOut).toBe(false);
  });

  it('counts an aged-out observed row under Observed and Aged out, not Stale', async () => {
    seed(hippoRoot, 'an observed row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    seed(hippoRoot, 'a row a human rejected through hippo invalidate', {
      confidence: 'stale',
      last_retrieved: ago(1),
    });

    const out = await hippo(home, ['status']);

    expect(out).toMatch(/Observed:\s+1/);
    expect(out).toMatch(/Stale:\s+1/);
    expect(out).toMatch(/Aged out:\s+1 {2}\(of the above; excludes pinned, verified\)/);
  });

  it('reports the stored tier and aged_out from recall --why JSON', async () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const out: { results: Array<{ confidence: string; aged_out: boolean }> } = JSON.parse(
      await hippo(home, ['recall', 'haddock', '--json', '--why']),
    );

    expect(out.results[0]!.confidence).toBe('observed');
    expect(out.results[0]!.aged_out).toBe(true);
  });

  it('reports the stored tier and aged_out from explain --json', async () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const out: { results: Array<{ confidence: string; aged_out: boolean }> } = JSON.parse(
      await hippo(home, ['explain', 'haddock', '--json']),
    );

    expect(out.results[0]!.confidence).toBe('observed');
    expect(out.results[0]!.aged_out).toBe(true);
  });

  it('omits aged_out from context --format json, which reports post-retrieval state', async () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const payload: { memories: Array<{ content: string; confidence: string }> } = JSON.parse(
      await hippo(home, ['context', 'haddock', '--format', 'json']),
    );

    const row = payload.memories.find((e) => e.content.includes('haddock'));
    expect(row).toBeDefined();
    expect(row!.confidence).toBe('observed');
    expect(row).not.toHaveProperty('aged_out');
  });

  it('reports the stored tier and aged_out from the dashboard payload', async () => {
    const e = seed(hippoRoot, 'a dashboard row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    server = serveDashboard(hippoRoot, 0, DASHBOARD_TOKEN);
    const port = await boundPort(server);

    // SAFETY: each route returns the dashboard-types.ts shape named in the cast.
    const overview = JSON.parse(await get(port, '/api/overview')) as { projects: Array<{ key: string }> };
    const key = encodeURIComponent(overview.projects[0]!.key);
    // SAFETY: the memory page route returns the MemoryPage of dashboard-types.ts.
    const page = JSON.parse(await get(port, `/api/projects/${key}/memories`)) as {
      rows: Array<{ id: string; confidence: string }>;
    };
    // SAFETY: the memory route returns the MemoryDetail of dashboard-types.ts.
    const detail = JSON.parse(await get(port, `/api/memory/${e.id}`)) as { confidence: string; agedOut: boolean };

    expect(page.rows.find((m) => m.id === e.id)?.confidence).toBe('observed');
    expect(detail.confidence).toBe('observed');
    expect(detail.agedOut).toBe(true);
  });

  it('renders the pair on hippo trace, the surface that reads without retrieving', async () => {
    const e = seed(hippoRoot, 'a traced row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    expect(await hippo(home, ['trace', e.id])).toContain('observed, aged');

    const json: { confidence: string; aged_out: boolean } = JSON.parse(
      await hippo(home, ['trace', e.id, '--json']),
    );
    expect(json.confidence).toBe('observed');
    expect(json.aged_out).toBe(true);
  });

  it('keeps the Pinned column aligned when the label carries its aged suffix', async () => {
    const aged = seed(hippoRoot, 'a traced row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    const fresh = seed(hippoRoot, 'a traced row retrieved yesterday', {
      confidence: 'observed',
      last_retrieved: ago(1),
    });

    const line = async (id: string): Promise<string> =>
      /Confidence:.*/.exec(await hippo(home, ['trace', id]))![0];
    const agedLine = await line(aged.id);

    expect(agedLine).toContain('observed, aged');
    expect(agedLine.indexOf('Pinned:')).toBe((await line(fresh.id)).indexOf('Pinned:'));
  });

  it('renders the pair on hippo recall, while context un-ages what it returns', async () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    seed(hippoRoot, 'a distinctive kipper fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    expect(await hippo(home, ['recall', 'haddock'])).toContain('[observed, aged]');
    expect(await hippo(home, ['context', 'kipper'])).toContain('[observed]');
    expect(await hippo(home, ['context', 'kipper'])).not.toContain('aged');
  });

  it('renders the stored tier at the MCP compact label', async () => {
    seed(hippoRoot, 'a distinctive haddock fact a human rejected', {
      confidence: 'stale',
      last_retrieved: ago(1),
    });

    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_recall', arguments: { query: 'haddock' } },
      },
      { hippoRoot, tenantId: 'default', actor: 'test', role: 'admin', hostAdmin: true, store: sqliteStore(hippoRoot) },
    );
    expect(JSON.stringify(res)).toContain('[stale]');
  });
});
