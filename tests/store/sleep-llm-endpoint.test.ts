// A sleep with HIPPO_LLM_BASE_URL set sends every LLM pass to that endpoint and to no other host, whatever else is in the env.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Layer } from '../../src/base/memory/entry.js';
import { consolidate, sleep, type ConsolidationResult } from '../../src/index.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

const ZEBRA = 'zebra-7731';
const SUMMARY = 'alice ships the API layer and reviews every schema migration before it lands.';

interface Asked {
  kind: 'extract' | 'summary' | 'other';
  model: string;
}

interface Endpoint {
  asked: Asked[];
  hosts: string[];
  close: () => Promise<void>;
}

let endpoint: Endpoint;

function classify(prompt: string): Asked['kind'] {
  if (prompt.startsWith('You are extracting factual statements')) return 'extract';
  return prompt.includes('Topic:') ? 'summary' : 'other';
}

/** A loopback chat endpoint; `globalThis.fetch` still reaches it, and throws for any other host. */
async function startEndpoint(extractContent: string): Promise<Endpoint> {
  const asked: Asked[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body: { model: string; messages: Array<{ content: string }> } = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      const kind = classify(body.messages[0].content);
      asked.push({ kind, model: body.model });
      const content = kind === 'extract' ? extractContent : SUMMARY;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() was given a TCP port, so address() is AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo;
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    hosts.push(host);
    if (host !== `127.0.0.1:${port}`) throw new Error(`a call left the box for ${host}`);
    return realFetch(input, init);
  });
  vi.stubEnv('HIPPO_LLM_BASE_URL', `http://127.0.0.1:${port}/v1`);
  vi.stubEnv('HIPPO_LLM_MODEL', 'local-model');
  // A stale key must lose to the endpoint.
  vi.stubEnv('ANTHROPIC_API_KEY', 'stale-not-a-key');
  return {
    asked,
    hosts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function seededRoot(): string {
  const root = makeRoot('sleep-endpoint');
  writeEntry(root, createMemory('the release train leaves every second thursday'));
  for (const text of [
    'alice ships the API layer',
    'alice reviews every schema migration',
    'alice owns the release train',
  ]) {
    writeEntry(root, createMemory(text, { layer: Layer.Episodic, dagLevel: 1, tags: ['extracted', 'speaker:alice'] }));
  }
  return root;
}

function passFailedMessages(result: ConsolidationResult): string[] {
  return result.events.flatMap((e) => (e.kind === 'passFailed' ? [e.message] : []));
}

let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await endpoint?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectOnlyTheEndpoint(): void {
  expect(endpoint.asked.map((a) => a.kind)).toEqual(expect.arrayContaining(['extract', 'summary']));
  for (const a of endpoint.asked) expect(a.model).toBe('local-model');
  expect(new Set(endpoint.hosts).size).toBe(1);
}

describe('sleep over an OpenAI-compatible endpoint', () => {
  it('consolidate sends the extraction and the DAG summary to the endpoint only', async () => {
    endpoint = await startEndpoint('[]');
    await consolidate(seededRoot());
    expectOnlyTheEndpoint();
  });

  it('the published sleep does the same through the entry infra', async () => {
    endpoint = await startEndpoint('[]');
    vi.stubEnv('HIPPO_HOME', makeRoot('sleep-endpoint-global'));
    const root = seededRoot();
    await sleep(
      {
        tenantId: 'default',
        actor: { subject: 't', role: 'admin', hostAdmin: true },
        store: sqliteStore(root),
        config: loadConfig(root),
      },
      { noShare: true },
    );
    expectOnlyTheEndpoint();
  });

  it('a base URL with no model is a refusal in the events, and no call is made', async () => {
    endpoint = await startEndpoint('[]');
    vi.stubEnv('HIPPO_LLM_MODEL', '');
    const result = await consolidate(seededRoot());
    expect(passFailedMessages(result).join('\n')).toContain('HIPPO_LLM_MODEL is required');
    expect(endpoint.asked).toEqual([]);
    expect(endpoint.hosts).toEqual([]);
  });

  it('a reply that is not JSON never reaches an event or a log line', async () => {
    endpoint = await startEndpoint(`${ZEBRA} not json`);
    const result = await consolidate(seededRoot());
    expect(passFailedMessages(result)).toContain('unparseable response: the reply is not a JSON array');
    expect(JSON.stringify(result.events)).not.toContain(ZEBRA);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain(ZEBRA);
  });
});
