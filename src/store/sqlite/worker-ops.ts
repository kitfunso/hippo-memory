// What crosses between the server thread and a store worker, and which kind of worker runs each store method.
import type { StoreGroups } from '../port.js';
import type { WireError } from './error-codec.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every write. */
export type OpMode = 'read' | 'write';

export type OpModes<G> = { readonly [M in keyof G]: OpMode };

/** The store groups that answer from a worker. Tagged by effect, not by name: predictionBaserate appends an audit row, so it is a write. */
export const WORKER_OPS = {
  predictions: {
    savePrediction: 'write',
    closePrediction: 'write',
    predictionById: 'read',
    listPredictions: 'read',
    predictionBaserate: 'write',
  },
} as const satisfies { readonly [G in keyof StoreGroups]?: OpModes<StoreGroups[G]> };

export type WorkerGroup = keyof typeof WORKER_OPS;

export interface WorkerInit {
  readonly hippoRoot: string;
  readonly mode: OpMode;
  /** Lock wait of the thread's connection. */
  readonly busyWaitMs: number;
}

export interface Job {
  readonly id: number;
  /** `<group>.<method>` of the synchronous store. */
  readonly op: string;
  readonly args: readonly unknown[];
  /** Of the request the call belongs to, so the thread's log lines carry it. */
  readonly requestId: string | undefined;
  /** wal_autocheckpoint as the server thread has it: a worker cannot see the checkpointer start or stop. */
  readonly walPages: number;
}

/** Both kinds carry the audit rows the job failed to write, since the count `/health` reports lives on the server thread. */
export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown; readonly auditFailures: number }
  | { readonly id: number; readonly ok: false; readonly error: WireError; readonly auditFailures: number };
