import type { MemoryEntry } from '../../memory/entry.js';
import type { SetAsideResult, SetAsideWhy } from './project-tags.js';
import type { MethodEffects } from './effects.js';

export interface AgentImport {
  applyContainer(plan: ContainerApply): Promise<ContainerApplied>;
}

/** What each AgentImport method does to the store; every adapter honours it. */
export const AGENT_IMPORT_EFFECTS = {
  applyContainer: 'write',
} as const satisfies MethodEffects<AgentImport>;

/** A live row as the plan read it. */
export interface PlannedRow {
  readonly id: string;
  readonly source: string;
  readonly tagged: boolean;
}

export interface ContainerApply {
  readonly tenantId: string;
  readonly dryRun: boolean;
  readonly tag: string;
  readonly prefixes: readonly string[];
  readonly rows: readonly PlannedRow[];
  readonly steps: readonly ImportStep[];
}

/** A legacy row outside the prefixes takes a note's source; the apply refuses unless it is still
 * live at `from`. */
export interface AdoptStep {
  readonly kind: 'adopt';
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

interface MoveStep {
  readonly kind: 'move';
  readonly id: string;
  readonly to: string;
  readonly origin: string | null;
}

interface MoveDormantStep {
  readonly kind: 'moveDormant';
  readonly from: string;
  readonly to: string;
  readonly origin: string | null;
}

interface RetagStep {
  readonly kind: 'retag';
  readonly id: string;
}

interface SupersedeStep {
  readonly kind: 'supersede';
  readonly id: string;
  readonly by: string;
}

interface WriteStep {
  readonly kind: 'write';
  readonly entry: MemoryEntry;
  readonly supersedes: readonly string[];
}

/** The dormant row returns as `revived`; when it is gone or its id is taken, `fresh` is written
 * instead. */
export interface RestoreStep {
  readonly kind: 'restore';
  readonly dormantId: string;
  readonly revived: MemoryEntry;
  readonly fresh: MemoryEntry;
}

interface SetAsideStep {
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

/** Per step: 'done', 'skipped' (a supersede another writer did first), a write's gate result,
 * 'restored' or which way a set-aside went. A restore whose row was gone answers its fresh
 * write's result. */
export type StepOutcome =
  | 'done'
  | 'skipped'
  | 'restored'
  | SetAsideResult['kind']
  | GatedWriteResult;

export interface MirrorFailure {
  readonly id: string;
  readonly message: string;
}

export type ContainerApplied =
  | {
      readonly kind: 'applied';
      readonly outcomes: readonly StepOutcome[];
      readonly unpurged: readonly MirrorFailure[];
    }
  /** The rows under the prefixes, or an adopted row, changed since the read: nothing was written. */
  | { readonly kind: 'changed' };

export interface RenameSourceOptions {
  readonly from: string;
  readonly to: string;
  readonly origin: string | null;
}

export type GatedWriteResult =
  | 'written'
  | 'skipped:not-worth-storing'
  | 'skipped:secret'
  | 'skipped:rejected';
