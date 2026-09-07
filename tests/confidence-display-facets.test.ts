// The stored confidence tier and the derived age-out are two facts that
// `resolveConfidence` fused into one, making a rejected row and an aged-out
// one indistinguishable at every display site.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, confidenceFacets, resolveConfidence, type MemoryEntry } from '../src/memory.js';
import { serveDashboard } from '../src/dashboard.js';
import { handleMcpRequest } from '../src/mcp/server.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');
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
  const e = { ...createMemory(content, { tags: ['facets'] }), ...over } as MemoryEntry;
  writeEntry(root, e);
  return e;
}

function runCli(cwd: string, args: string[]): string {
  if (!existsSync(CLI)) {
    throw new Error(`bin/hippo.js not found at ${CLI} - run \`npm run build\` first`);
  }
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo-global') },
  });
}

function get(port: number, path: string): Promise<string> {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (r) => {
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
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-facets-'));
    hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);
    prevHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = join(home, '.hippo-global');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res, rej) => server!.close((e) => (e ? rej(e) : res())));
      server = undefined;
    }
    if (prevHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
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
    const shapes: Array<[Partial<MemoryEntry>, string]> = [
      [{ confidence: 'observed', last_retrieved: ago(45) }, 'stale'],
      [{ confidence: 'observed', last_retrieved: ago(1) }, 'observed'],
      [{ confidence: 'inferred', last_retrieved: ago(45) }, 'stale'],
      [{ confidence: 'stale', last_retrieved: ago(1) }, 'stale'],
      [{ confidence: 'verified', last_retrieved: ago(999) }, 'verified'],
      [{ confidence: 'observed', last_retrieved: ago(999), pinned: true }, 'observed'],
    ];
    for (const [over, want] of shapes) {
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

  it('counts an aged-out observed row under Observed and Aged out, not Stale', () => {
    seed(hippoRoot, 'an observed row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    seed(hippoRoot, 'a row a human rejected through hippo invalidate', {
      confidence: 'stale',
      last_retrieved: ago(1),
    });

    const out = runCli(home, ['status']);

    expect(out).toMatch(/Observed:\s+1/);
    expect(out).toMatch(/Stale:\s+1/);
    expect(out).toMatch(/Aged out:\s+1 {2}\(of the above; excludes pinned, verified\)/);
  });

  it('reports the stored tier and aged_out from recall --why JSON', () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const out = JSON.parse(runCli(home, ['recall', 'haddock', '--json', '--why'])) as {
      results: Array<{ confidence: string; aged_out: boolean }>;
    };

    expect(out.results[0]!.confidence).toBe('observed');
    expect(out.results[0]!.aged_out).toBe(true);
  });

  it('reports the stored tier and aged_out from explain --json', () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const out = JSON.parse(runCli(home, ['explain', 'haddock', '--json'])) as {
      results: Array<{ confidence: string; aged_out: boolean }>;
    };

    expect(out.results[0]!.confidence).toBe('observed');
    expect(out.results[0]!.aged_out).toBe(true);
  });

  it('omits aged_out from context --format json, which reports post-retrieval state', () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const payload = JSON.parse(
      runCli(home, ['context', 'haddock', '--format', 'json']),
    ) as { memories: Array<Record<string, unknown>> };

    const row = payload.memories.find((e) => String(e['content']).includes('haddock'));
    expect(row).toBeDefined();
    expect(row!['confidence']).toBe('observed');
    expect(row).not.toHaveProperty('aged_out');
  });

  it('reports the stored tier and aged_out from the dashboard payload', async () => {
    const e = seed(hippoRoot, 'a dashboard row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    const port = 31000 + Math.floor(Math.random() * 5000);
    server = serveDashboard(hippoRoot, port);
    await new Promise<void>((res) => {
      if (server!.listening) res();
      else server!.once('listening', () => res());
    });

    const memories = JSON.parse(await get(port, '/api/memories')) as Array<{
      id: string;
      confidence: string;
      aged_out: boolean;
    }>;
    const stats = JSON.parse(await get(port, '/api/stats')) as {
      by_confidence: Record<string, number>;
      aged_out: number;
    };

    const row = memories.find((m) => m.id === e.id);
    expect(row?.confidence).toBe('observed');
    expect(row?.aged_out).toBe(true);
    expect(stats.by_confidence['observed']).toBe(1);
    expect(stats.aged_out).toBe(1);
  }, 15_000);

  it('renders the pair on hippo trace, the surface that reads without retrieving', () => {
    const e = seed(hippoRoot, 'a traced row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    expect(runCli(home, ['trace', e.id])).toContain('observed, aged');

    const json = JSON.parse(runCli(home, ['trace', e.id, '--json'])) as {
      confidence: string;
      aged_out: boolean;
    };
    expect(json.confidence).toBe('observed');
    expect(json.aged_out).toBe(true);
  });

  it('keeps the Pinned column aligned when the label carries its aged suffix', () => {
    const aged = seed(hippoRoot, 'a traced row nobody has retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    const fresh = seed(hippoRoot, 'a traced row retrieved yesterday', {
      confidence: 'observed',
      last_retrieved: ago(1),
    });

    const line = (id: string): string =>
      /Confidence:.*/.exec(runCli(home, ['trace', id]))![0];
    const agedLine = line(aged.id);

    expect(agedLine).toContain('observed, aged');
    expect(agedLine.indexOf('Pinned:')).toBe(line(fresh.id).indexOf('Pinned:'));
  });

  it('renders the pair on hippo recall, while context un-ages what it returns', () => {
    seed(hippoRoot, 'a distinctive haddock fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });
    seed(hippoRoot, 'a distinctive kipper fact nobody retrieved lately', {
      confidence: 'observed',
      last_retrieved: ago(45),
    });

    expect(runCli(home, ['recall', 'haddock'])).toContain('[observed, aged]');
    expect(runCli(home, ['context', 'kipper'])).toContain('[observed]');
    expect(runCli(home, ['context', 'kipper'])).not.toContain('aged');
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
      { hippoRoot, tenantId: 'default', actor: 'test' },
    );
    expect(JSON.stringify(res)).toContain('[stale]');
  }, 30_000);
});
