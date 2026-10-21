// `hippo recall` and `hippo context` on a store a `hippo serve` holds ask that server for the nearest rows and print
// what they print with no server; a server that does not answer costs one warn line and the local scan.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, withWriteScope } from '../../src/db/index.js';
import { embedAll } from '../../src/domain/search/embed-memories.js';
import { serve } from '../../src/server.js';
import type { VectorCandidateSpec } from '../../src/store/port/vector-reads.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { localIndex } from '../_helpers/cli-stores.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { boundPort } from '../_helpers/listen.js';
import { makeRoot, makeStore, type MadeStore } from '../_helpers/make-root.js';
import { ROUTED_CLI_ENV } from '../_helpers/routed-cli-env.js';
import { hippoRunAsync } from '../_helpers/spawn-hippo.js';

// Past the graph threshold of 1,000 vectors, so the CLI asks the server; the first case fails if the threshold rises.
const ROWS = 1_100;
const QUERY = 'deploys pipelines';
const PROJECT = 'nearest-demo';
// In this order on every copy, so the retrieval bumps of the first leave the same store for the second.
const COMMANDS = [
  ['recall', QUERY, '--budget', '1500'],
  ['context', QUERY, '--budget', '1500'],
] as const;
const HOP_WARN = 'the hippo server did not answer the nearest-vector read, so this process scans its own store';

type Run = Awaited<ReturnType<typeof hippoRunAsync>>;

let embeddings: HashedEmbeddings;
let template: string;
let globalRoot: string;
// After the rows are written, and the same for every run, so a strength reads alike on each.
let fakeNow: string;

// Each case gets its own copy, so one case's retrieval bumps never reach the store another reads; the project file
// gives every copy the project its rows came from.
function copyOfTemplate(): MadeStore {
  const made = makeStore('nearest-run', { init: false });
  cpSync(template, made.root, { recursive: true });
  writeFileSync(join(made.base, '.hippo-project.json'), JSON.stringify({ id: PROJECT }));
  return made;
}

function run(base: string, args: readonly string[]): Promise<Run> {
  return hippoRunAsync(args, {
    cwd: base,
    env: {
      ...process.env,
      ...ROUTED_CLI_ENV,
      HIPPO_HOME: globalRoot,
      HIPPO_FAKE_NOW: fakeNow,
      HIPPO_ALLOW_KEYLESS_LOCAL: '1',
      HIPPO_API_KEY: '',
      OPENAI_API_KEY: 'sk-test',
    },
    timeout: 25_000,
  });
}

async function runAll(base: string): Promise<Run[]> {
  const runs: Run[] = [];
  for (const args of COMMANDS) runs.push(await run(base, args));
  return runs;
}

beforeAll(async () => {
  embeddings = await startHashedEmbeddings();
  vi.stubEnv('OPENAI_API_KEY', 'sk-test');
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
  globalRoot = makeRoot('nearest-global');
  template = makeRoot('nearest-template', {
    config: { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } },
  });
  const db = openHippoDb(template);
  try {
    withWriteScope(db, 'seed_rows', () => {
      for (let i = 0; i < ROWS; i++) {
        const text = `${i % 9 === 0 ? 'deploy pipeline' : 'release notes'} step ${i} touches service ${i % 37}`;
        const entry = createMemory(text, { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
        writeEntryDbOnly(db, { ...entry, originProject: PROJECT });
      }
    });
  } finally {
    closeHippoDb(db);
  }
  expect(await embedAll(localIndex(template))).toBe(ROWS);
  fakeNow = new Date(Date.now() + 60_000).toISOString();
}, 60_000);

afterAll(async () => {
  await embeddings.close();
  vi.unstubAllEnvs();
});

describe('hippo recall and hippo context beside a hippo serve on the same store', () => {
  it('print byte for byte what they print with no server, and the server answered the nearest-row reads', async () => {
    const direct = await runAll(copyOfTemplate().base);
    const { base, root } = copyOfTemplate();
    const local = sqliteStore(root);
    const asked: VectorCandidateSpec[] = [];
    const store = {
      ...local,
      vectors: {
        ...local.vectors,
        nearestEntries: (query: readonly number[], spec: VectorCandidateSpec) => {
          asked.push(spec);
          return local.vectors.nearestEntries(query, spec);
        },
      },
    };
    const server = await serve({ hippoRoot: root, port: 0, store, autoSleep: false });
    let hopped: Run[];
    try {
      hopped = await runAll(base);
    } finally {
      await server.stop();
    }

    for (const [i, [command]] of COMMANDS.entries()) {
      expect(direct[i].status, direct[i].stderr).toBe(0);
      expect(direct[i].stdout, command).toContain('deploy pipeline');
      expect(hopped[i].status, hopped[i].stderr).toBe(0);
      expect(hopped[i].stdout, command).toBe(direct[i].stdout);
      expect(hopped[i].stderr, command).not.toContain(HOP_WARN);
    }
    expect(asked.length).toBeGreaterThanOrEqual(COMMANDS.length);
    expect(asked.every((spec) => spec.tenantId === 'default')).toBe(true);
  }, 60_000);

  it('scans its own store after one warn line when the server takes the read and never answers', async () => {
    const direct = await run(copyOfTemplate().base, COMMANDS[0]);
    const { base, root } = copyOfTemplate();
    const startedAt = new Date().toISOString();
    const posts: string[] = [];
    const stalled = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ started_at: startedAt }));
        return;
      }
      posts.push(`${req.method} ${req.url}`);
    });
    const port = await boundPort(stalled.listen(0, '127.0.0.1'));
    const url = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(root, 'server.pid'),
      JSON.stringify({ schema: 1, pid: process.pid, port, url, started_at: startedAt }),
    );
    let fellBack: Run;
    try {
      fellBack = await run(base, COMMANDS[0]);
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }

    expect(fellBack.status, fellBack.stderr).toBe(0);
    expect(fellBack.stdout).toBe(direct.stdout);
    expect(posts).toContain('POST /v1/vectors/nearest');
    expect(fellBack.stderr.split(HOP_WARN)).toHaveLength(2);
  }, 60_000);
});
