// POST /v1/sleep and the server's auto-sleep queue while another process holds the store's sleep claim: the sleep answers 200
// with nothing done, saves no vector graph file, and a refused auto-sleep is a normal answer, not an error.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerHandle } from '../../src/server.js';
import { takeFileLock } from '../../src/host/file-lock.js';
import { log } from '../../src/base/util/log.js';
import { createSleepQueue } from '../../src/surface/server/sleep-offload.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { clusteredVectors, seedVectorRows } from '../_helpers/vector-rows.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import { sleepRuns } from '../_helpers/sleep-runs.js';
import { waitFor } from '../_helpers/wait-for.js';

// A sleep saves the vector graph file only for a store of at least 1,000 vectors, so a sleep that ran leaves this file.
const VECTOR_DIM = 32;
const VECTORS = 1_100;

interface SleepBody {
  readonly active: number;
  readonly removed: number;
  readonly mergedEpisodic: number;
  readonly newSemantic: number;
  readonly dryRun: boolean;
  readonly alreadyRunning?: { readonly since: string };
}

let home: string;
let graphFile: string;
let handle: ServerHandle | undefined;
const holders: { release: () => void }[] = [];

beforeEach(() => {
  home = makeRoot('sleep-running');
  vi.stubEnv('HIPPO_HOME', home);
  seedVectorRows(
    home,
    clusteredVectors(VECTORS, VECTOR_DIM, 3).map((vector, i) => ({ id: `v-${i}`, tenantId: 'default', vector })),
  );
  graphFile = join(home, `vector-graph-${VECTOR_DIM}.bin`);
});

afterEach(async () => {
  for (const holder of holders.splice(0)) holder.release();
  await handle?.stop();
  handle = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The claim, held by a connection of the test's own, as another process would hold it. */
function holdClaim(): { release: () => void } {
  const take = takeFileLock(join(home, 'sleep.lock.db'));
  if (take.kind !== 'taken') throw new Error(`test setup: the claim was already ${take.kind}`);
  holders.push(take.lock);
  return take.lock;
}

async function postSleep(): Promise<Response> {
  handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
  return fetch(`${handle.url}/v1/sleep`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ no_share: true }),
  });
}

describe('POST /v1/sleep while another sleep holds the claim', () => {
  it('answers 200 with nothing done and saves no vector graph file', async () => {
    holdClaim();

    const res = await postSleep();

    expect(res.status).toBe(200);
    expect(await jsonAs<SleepBody>(res)).toEqual({
      active: 0,
      removed: 0,
      mergedEpisodic: 0,
      newSemantic: 0,
      dryRun: false,
      alreadyRunning: { since: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) },
    });
    // Stopping waits for the sleep child to leave, which is when it would have saved the file.
    await handle?.stop();
    expect(existsSync(graphFile)).toBe(false);
  });

  it('saves the vector graph file when no other sleep holds the claim', async () => {
    const res = await postSleep();

    expect(res.status).toBe(200);
    expect((await jsonAs<SleepBody>(res)).alreadyRunning).toBeUndefined();
    await waitFor(() => existsSync(graphFile), { timeoutMs: 20_000, what: 'the vector graph file a sleep saves' });
  }, 60_000);
});

describe('the server auto-sleep queue while another sleep holds the claim', () => {
  it('settles the turn with the refusal, logs no error and runs no consolidation', async () => {
    holdClaim();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const queue = createSleepQueue(home, true);

    await expect(queue.consolidate()).resolves.toBeUndefined();
    await queue.settled();

    expect(error).not.toHaveBeenCalled();
    expect(sleepRuns(home)).toBe(0);
  });
});
