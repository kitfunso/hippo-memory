// What crosses between the server thread and a store worker, and which kind of worker runs each
// store method.
import { type HippoStore, STORE_EFFECTS } from '../../base/ports/store.js';
import type { WireError } from './error-codec.js';
import type { TenantMark } from './tenant-wire.js';
import type { StoreRules } from '../../base/ports/infra.js';

/** 'write' runs on the one writer thread; 'read' on a reader, whose connection refuses every
 * write. */
export type OpMode = 'read' | 'write';

/** Where the executor sends a call: by its mode, or 'pinned-read' for a read only the first
 * reader runs, since that thread alone holds the store's vector graph and a second copy would
 * double its memory. */
export type OpRoute = OpMode | 'pinned-read';

export type OpPlaces<G> = { readonly [M in keyof G]: OpRoute };

/** Reads only the first reader runs, since that thread alone holds the store's vector graph. */
const PINNED_READS: Placement = { vectors: ['nearestEntries'] };

/** Methods the port calls reads that hippo.db runs on the one writer thread. */
const ON_WRITER: Placement = {
  // A snapshot load rewrites the active-task mirror file.
  sessions: ['loadSnapshot'],
  // A session's lock token and staged vectors sit on the thread that opened it.
  embeddingIndex: ['open'],
};

type Placement = { readonly [G in keyof StoreEffects]?: readonly (keyof StoreEffects[G])[] };
type StoreEffects = typeof STORE_EFFECTS;
type WorkerOps = {
  readonly [G in keyof StoreEffects]: { readonly [M in keyof StoreEffects[G]]: OpRoute };
};

function routeOf(group: string, method: string, effect: OpMode): OpRoute {
  const named = (placement: Placement): boolean =>
    new Map<string, readonly PropertyKey[]>(Object.entries(placement))
      .get(group)
      ?.includes(method) ?? false;
  if (named(PINNED_READS)) return 'pinned-read';
  return named(ON_WRITER) ? 'write' : effect;
}

function placedOps(): WorkerOps {
  // SAFETY: the map keeps every group and method key of STORE_EFFECTS and gives each an OpRoute.
  return Object.fromEntries(
    Object.entries(STORE_EFFECTS).map(([group, effects]) => [
      group,
      Object.fromEntries(
        Object.entries<OpMode>(effects).map(([method, effect]) => [
          method,
          routeOf(group, method, effect),
        ]),
      ),
    ]),
  ) as WorkerOps;
}

/** Each store method but the local files, placed by its port effect, PINNED_READS and ON_WRITER, so
 * the server thread runs no SQLite; finishRecall writes the global rows from this writer too. */
export const WORKER_OPS = placedOps();

/** Sent by the executor itself and by no store method: the writer runs the store's open-time
 * setup once, before any reader is sent a job. */
export const STORE_SETUP_OP = 'setup';

export type WorkerGroup = keyof typeof WORKER_OPS;

/** The base methods the op table names. */
export type WorkerBase = Pick<HippoStore, keyof typeof WORKER_OPS.base>;

export interface WorkerInit {
  readonly hippoRoot: string;
  readonly mode: OpMode;
  /** Lock wait of the thread's connection. */
  readonly busyWaitMs: number;
  /** The process's default lock wait, for every other open: a thread's module state starts at 5000. */
  readonly processBusyWaitMs: number;
  /** Set on the first reader alone, which answers 'pinned-read' calls from the vector graph it
   * holds. */
  readonly pinned?: boolean;
  /** Stored vectors a store holds before the pinned reader builds its graph;
   * VECTOR_GRAPH_THRESHOLD when omitted. */
  readonly vectorGraphThreshold?: number | undefined;
  /** Stored vectors past which the pinned reader keeps no graph; the config default when
   * omitted. */
  readonly vectorGraphMaxVectors?: number | undefined;
  /** One shared integer the writer sets to a job's id before that job may commit; the server
   * thread reads it when the job passes its deadline. */
  readonly commitFlag?: SharedArrayBuffer;
  /** The strength model and fake clock the parent's root opened with, which the thread's store
   * opens with. */
  readonly rules: StoreRules;
}

export interface Job {
  readonly id: number;
  /** `<group>.<method>` of the synchronous store, `base.<method>` for a base one. */
  readonly op: string;
  readonly args: readonly unknown[];
  /** Where ALL_TENANTS sat in the arguments, since a symbol cannot be copied to the thread. */
  readonly allTenants: readonly TenantMark[];
  /** Of the request the call belongs to, so the thread's log lines carry it. */
  readonly requestId: string | undefined;
  /** wal_autocheckpoint as the server thread has it: a worker cannot see the checkpointer start
   * or stop. */
  readonly walPages: number;
}

/** Both kinds carry the audit rows the job failed to write, since the count `/health` reports
 * lives on the server thread. */
export type Reply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: unknown;
      readonly auditFailures: number;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: WireError;
      readonly auditFailures: number;
    };
