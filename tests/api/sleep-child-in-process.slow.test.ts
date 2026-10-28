// The sleep child's job body in process: its 'message' listener is captured on import, and send and exit are stubbed.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, MockInstance } from 'vitest';
import { remember } from '../../src/api/index.js';
import type { SleepJob, SleepMessage, SleepReply } from '../../src/surface/server/sleep-offload.js';
import type { SleepResult } from '../../src/api/sleep/sleep.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { callMatching, fire, recordListeners, stubExit, type Listener } from '../_helpers/process-stubs.js';
import { makeRoot } from '../_helpers/make-root.js';
import { clusteredVectors, seedVectorRows } from '../_helpers/vector-rows.js';
import { VECTOR_GRAPH_THRESHOLD } from '../../src/db/vector-graph-rows.js';
import { STORE_RUN_MS, STORE_RUN_REASON } from '../_helpers/wait-for.js';
import { recordBusyWaitsAsync } from '../_helpers/count-statements.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let exit: MockInstance;
let sent: Array<SleepReply<SleepResult>>;
let listeners: Map<string, Listener[]>;
let hadSend: boolean;

beforeEach(async () => {
  home = makeRoot('sleep-child');
  vi.stubEnv('HIPPO_HOME', home);
  sent = [];
  hadSend = 'send' in process;
  // A worker that is not an IPC child has no process.send; this stands in for the channel.
  Object.defineProperty(process, 'send', {
    configurable: true,
    writable: true,
    value: (reply: SleepReply<SleepResult>, done: (err: Error | null) => void) => {
      sent.push(reply);
      done(null);
      return true;
    },
  });
  listeners = recordListeners(process, 'once');
  exit = stubExit();
  vi.resetModules();
  await import('../../src/surface/server/sleep-child.js');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!hadSend) Reflect.deleteProperty(process, 'send');
});

describe('sleep child', () => {
  it('runs the sleep job on the real store, replies with its result, and exits 0 after the reply', async () => {
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    await remember(ctx, { content: 'the child sleeps this row', kind: 'distilled' });
    const job: SleepJob = {
      kind: 'sleep',
      hippoRoot: home,
      tenantId: 'default',
      actor: ctx.actor,
      opts: { dryRun: true },
    };

    fire(listeners, 'message', job);
    await callMatching(exit, (code) => code === 0, { what: 'process.exit(0) after the reply' });
    expect(sent).toHaveLength(1);
    const reply = sent[0];
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result.dryRun).toBe(true);
      expect(reply.result.active).toBe(1);
      expect(reply.result.removed).toBe(0);
    }
  });

  it('replies not ok with the open error when the store file is not a database, and still exits 0', async () => {
    writeFileSync(join(home, 'hippo.db'), 'not a sqlite database');
    const job: SleepJob = { kind: 'consolidate', hippoRoot: home };
    fire(listeners, 'message', job);
    await callMatching(exit, (code) => code === 0, { what: 'process.exit(0) after the reply' });
    const reply = sent[0];
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.busy).toBe(false);
      expect(reply.message).toMatch(/not a database/i);
    }
  });

  it('replies to a sleep before it saves the vector graph file, opens with HIPPO_BUSY_WAIT_MS, then exits 0', async () => {
    // A child started with the knob: its root reads it on import.
    vi.stubEnv('HIPPO_BUSY_WAIT_MS', '4000');
    vi.resetModules();
    listeners = recordListeners(process, 'once');
    await import('../../src/surface/server/sleep-child.js');
    seedVectorRows(
      home,
      // The fewest rows that build the graph: the sleep child passes no threshold of its own.
      clusteredVectors(VECTOR_GRAPH_THRESHOLD, 32, 3).map((vector, i) => ({
        id: `v-${i}`,
        tenantId: 'default',
        vector,
      })),
    );
    const graphFile = join(home, 'vector-graph-32.bin');
    const fileAtReply: boolean[] = [];
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: (reply: SleepReply<SleepResult>, done: (err: Error | null) => void) => {
        fileAtReply.push(existsSync(graphFile));
        sent.push(reply);
        done(null);
        return true;
      },
    });
    const ctx = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
    const job: SleepMessage = {
      kind: 'sleep',
      hippoRoot: home,
      tenantId: 'default',
      actor: ctx.actor,
      opts: { noShare: true },
      deadline: Date.now() + 120_000,
    };

    const { waits } = await recordBusyWaitsAsync(async () => {
      fire(listeners, 'message', job);
      // A sleep and a whole graph build before the exit: 7.3 s on CI, past what one event may take.
      await callMatching(exit, (code) => code === 0, {
        what: 'process.exit(0) after the graph is saved',
        deadlineMs: STORE_RUN_MS,
        reason: STORE_RUN_REASON,
      });
    });

    expect(sent.map((reply) => reply.ok)).toEqual([true]);
    expect(fileAtReply).toEqual([false]);
    expect(existsSync(graphFile)).toBe(true);
    // The job's session opens at the server's 250 ms and its commit at sleep's own 5000; the graph save names no
    // wait, so its read-only opens take the knob.
    expect(waits).toContain('PRAGMA busy_timeout = 4000');
    expect(new Set(waits.filter((sql) => !sql.endsWith(' 4000')))).toEqual(
      new Set(['PRAGMA busy_timeout = 250', 'PRAGMA busy_timeout = 5000']),
    );
  });
});
