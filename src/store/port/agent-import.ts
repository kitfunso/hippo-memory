// The agent-memories import's reads and its one write per container: the sync plans a container's writes as data, and
// applyContainer runs them in one transaction once the rows they were planned on still stand.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { SetAsideResult, SetAsideWhy } from './project-tags.js';
import type { DormantSnapshot } from './types.js';

export interface AgentImport {
  /** The tenant's live rows whose source starts with `prefix`, oldest first. */
  liveBySourcePrefix(tenantId: string, prefix: string): Promise<MemoryEntry[]>;
  /** The tenant's readable dormant snapshots whose row's source starts with `prefix`. */
  dormantBySourcePrefix(tenantId: string, prefix: string): Promise<DormantSnapshot[]>;
  /** Per text, in order: live rows outside `prefix` that may hold it word for word, spacing aside; `origins` (global
   * store only) keeps user-global rows and those projects. A superset the caller checks again. */
  rowsHoldingOutsideSourcePrefix(
    tenantId: string,
    texts: readonly string[],
    prefix: string,
    origins: readonly string[] | null,
  ): Promise<HeldRow[][]>;
  /** The steps in order in one write scope, or a trial scope that rolls back on `dryRun`; mirrors follow the commit. */
  applyContainer(plan: ContainerApply): Promise<ContainerApplied>;
}

export interface HeldRow {
  readonly id: string;
  readonly content: string;
  readonly source: string;
}

/** A live row as the plan read it. */
export interface PlannedRow {
  readonly id: string;
  readonly source: string;
  /** Carries the plan's tag. */
  readonly tagged: boolean;
}

export interface ContainerApply {
  readonly tenantId: string;
  /** Rolls every step back, so the outcomes tell what a run would do. */
  readonly dryRun: boolean;
  /** The tool's tag: a retag adds it and a set-aside takes it off. */
  readonly tag: string;
  readonly prefixes: readonly string[];
  /** Every live row under `prefixes` the steps were planned on; any other set refuses the apply. */
  readonly rows: readonly PlannedRow[];
  readonly steps: readonly ImportStep[];
}

/** A legacy row outside the prefixes takes a note's source; the apply refuses unless it is still live at `from`. */
export interface AdoptStep {
  readonly kind: 'adopt';
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** A row under an earlier prefix moves to `to`, and to project `origin` when that is not null. */
export interface MoveStep {
  readonly kind: 'move';
  readonly id: string;
  readonly to: string;
  readonly origin: string | null;
}

/** Every dormant snapshot whose source starts with `from` moves under `to` the same way. */
export interface MoveDormantStep {
  readonly kind: 'moveDormant';
  readonly from: string;
  readonly to: string;
  readonly origin: string | null;
}

export interface RetagStep {
  readonly kind: 'retag';
  readonly id: string;
}

/** Skipped when another writer superseded the row first. */
export interface SupersedeStep {
  readonly kind: 'supersede';
  readonly id: string;
  readonly by: string;
}

/** Stored through the write gate; once written it supersedes each row of `supersedes`. */
export interface WriteStep {
  readonly kind: 'write';
  readonly entry: MemoryEntry;
  readonly supersedes: readonly string[];
}

/** The dormant row returns as `revived`; when it is gone or its id is taken, `fresh` is written instead. */
export interface RestoreStep {
  readonly kind: 'restore';
  readonly dormantId: string;
  readonly revived: MemoryEntry;
  readonly fresh: MemoryEntry;
}

export interface SetAsideStep {
  readonly kind: 'setAside';
  readonly id: string;
  readonly why: SetAsideWhy;
}

export type ImportStep =
  | AdoptStep
  | MoveStep
  | MoveDormantStep
  | RetagStep
  | SupersedeStep
  | WriteStep
  | RestoreStep
  | SetAsideStep;

/** Per step: 'done', 'skipped' (a supersede another writer did first), a write's gate result, 'restored' or which way
 * a set-aside went. A restore whose row was gone answers its fresh write's result. */
export type StepOutcome = 'done' | 'skipped' | 'restored' | SetAsideResult['kind'] | GatedWriteResult;

export interface MirrorFailure {
  readonly id: string;
  readonly message: string;
}

export type ContainerApplied =
  | {
      readonly kind: 'applied';
      readonly outcomes: readonly StepOutcome[];
      /** Mirrors of set-aside rows the commit could not remove. */
      readonly unpurged: readonly MirrorFailure[];
    }
  /** The rows under the prefixes, or an adopted row, changed since the read: nothing was written. */
  | { readonly kind: 'changed' };

export interface RenameSourceOptions {
  readonly from: string;
  readonly to: string;
  readonly origin: string | null;
}

export type GatedWriteResult = 'written' | 'skipped:not-worth-storing' | 'skipped:secret' | 'skipped:rejected';
