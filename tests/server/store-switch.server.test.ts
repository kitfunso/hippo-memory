// The port-only job's own check: under HIPPO_TEST_STORE=port-only a suite's serve() writes and reads through the port
// of a store that is not hippo.db's; on the default run it serves hippo.db's store. Both leave one row in hippo.db.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { ServerHandle } from '../../src/server.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { onPortOnly } from '../_helpers/store-switch.js';

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

it(`serve() with no store runs on ${onPortOnly ? 'a port-only store' : 'hippo.db'}`, async () => {
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
  expect(rowsInHippoDb()).toBe(1);
});
