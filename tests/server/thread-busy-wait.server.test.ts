// Each thread is its own root: the store worker and the dashboard reader set the lock wait they are handed before an open.
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultBusyWaitMs, setDefaultBusyWaitMs } from '../../src/db/busy.js';
import type { ReaderCall, ReaderReply } from '../../src/surface/server/dashboard-reader.js';
import { serveReads } from '../../src/surface/server/dashboard-reader-serve.js';
import { serveJobs } from '../../src/store/sqlite/worker-jobs.js';
import { recordBusyWaitsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';

const ports: MessagePort[] = [];
let processWait: number;

// The serve functions run here, in this worker's module graph, so each test puts back the wait a thread root set.
beforeEach(() => {
  processWait = defaultBusyWaitMs();
});

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  setDefaultBusyWaitMs(processWait);
});

function channel() {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  return { thread: port1, server: port2 };
}

describe('a thread root sets the lock wait it is handed', () => {
  it('the store worker thread sets the process wait for the opens that name none', async () => {
    const { thread, server } = channel();
    serveJobs(thread, {
      rules: {},
      hippoRoot: makeRoot('thread-busy-wait'),
      mode: 'write',
      busyWaitMs: 50,
      processBusyWaitMs: 300,
    });
    expect(defaultBusyWaitMs()).toBe(300);
    const closed = new Promise((resolve) => server.once('close', resolve));
    server.postMessage('stop');
    await closed;
  });

  it('the dashboard reader thread opens the store with it', async () => {
    const { thread, server } = channel();
    serveReads(thread, { hippoRoot: makeRoot('thread-busy-wait'), tenantId: 'default', busyWaitMs: 300 });
    const ask = (call: ReaderCall): Promise<ReaderReply> =>
      new Promise((resolve) => {
        server.once('message', resolve);
        server.postMessage(call);
      });
    const now = Date.now();
    const { result, waits } = await recordBusyWaitsAsync(() =>
      ask({ id: 1, op: 'overview', fresh: true, nowMs: now, wallMs: now }),
    );
    expect(result.ok).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
    expect(new Set(waits)).toEqual(new Set(['PRAGMA busy_timeout = 300']));
    expect((await ask({ id: 2, op: 'close', nowMs: now, wallMs: now })).ok).toBe(true);
  });
});
