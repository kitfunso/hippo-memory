// The outside services a composition root hands the api in its Context; src/infra/ports.ts builds the real ones.
import type { Machine } from '../util/agent-homes.js';

export interface InfraPorts {
  /** The disk the agent-memory and project-repair reads look at, with its git. */
  readonly machine: Machine;
}
