// A store worker whose reply cannot be posted still closes its stores and its port on 'stop', and logs the failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { RequestStores } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { serveJobs } from '../../src/store/sqlite/worker-jobs.js';
import type { Job } from '../../src/store/sqlite/worker-ops.js';
import { log } from '../../src/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('store worker stop after a failed reply', () => {
  it('closes the stores and the port when the last job could not post its reply, and logs it with the error fields', async () => {
    const root = makeRoot('worker-jobs-cleanup');
    roots.push(root);
    const { port1, port2 } = new MessageChannel();
    const unhandled: unknown[] = [];
    const onUnhandled = <R>(reason: R): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const closeStores = vi.spyOn(RequestStores.prototype, 'close');
    const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
    // Both the reply and the error reply that follows it fail, as when the server thread is already gone.
    const post = vi.spyOn(port1, 'postMessage').mockImplementation(() => {
      throw new Error('port is gone');
    });
    try {
      serveJobs(port1, { hippoRoot: root, mode: 'write', busyWaitMs: 50 });
      const job: Job = {
        id: 7,
        op: 'entryWrites.writeEntry',
        allTenants: [],
        args: [
          {
            entry: createMemory('a write whose reply cannot be posted', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
            actor: 'test',
          },
        ],
        requestId: undefined,
        walPages: 100,
      };
      port2.postMessage(job);
      await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));

      const closesBefore = closeStores.mock.calls.length;
      const closed = new Promise((resolve) => port2.once('close', resolve));
      port2.postMessage('stop');
      await closed;
      // Let a rejection that nothing handled reach the process event.
      await new Promise((resolve) => setImmediate(resolve));

      expect(post).toHaveBeenCalledTimes(2);
      expect(closeStores).toHaveBeenCalledTimes(closesBefore + 1);
      expect(logged).toHaveBeenCalledWith(
        'store worker: no reply was posted for job 7',
        expect.objectContaining({ errorClass: 'Error', stack: expect.stringContaining('port is gone') }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
