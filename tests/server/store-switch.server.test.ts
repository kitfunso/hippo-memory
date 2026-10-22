// The memory-store job's own check: under HIPPO_TEST_STORE=memory a suite's serve() runs on memoryStore and leaves
// hippo.db as it was; on the default run it writes hippo.db as always.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { ServerHandle } from '../../src/server.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { onMemory } from '../_helpers/store-switch.js';

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('store-switch');
  handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

const rowsInHippoDb = (): number => {
  const db = openHippoDb(home);
  try {
    // SAFETY: the SELECT names the one column n.
    return (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  } finally {
    closeHippoDb(db);
  }
};

it(`serve() with no store runs on ${onMemory ? 'memoryStore' : 'hippo.db'}`, async () => {
  const res = await fetch(`${handle.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'the switch picks the store', kind: 'distilled' }),
  });
  expect(res.status).toBe(200);
  // SAFETY: POST /v1/memories answers the created memory's envelope.
  const { id } = (await res.json()) as { id: string };
  const listed = await (await fetch(`${handle.url}/v1/memories?q=switch`)).text();
  expect(listed).toContain(id);
  expect(rowsInHippoDb()).toBe(onMemory ? 0 : 1);
});
