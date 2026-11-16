// Rows and texts the sleep supersede tests share: each row carries one time for created and validFrom.
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { FIXED_NOW } from './fixed-clock.js';
import { makeRoot } from './make-root.js';

const MINUTE_MS = 60_000;
export const DAY = 24 * 60;
// Long enough that merge would cluster a pair, so a link is the only thing that keeps it apart.
export const OLD = 'The deploy script for the staging cluster runs on Jenkins nightly.';
export const HIDE = 'The deploy script for the staging cluster runs on Buildkite nightly now.';
export const SOFT = 'The deploy script for the staging cluster runs on Buildkite nightly.';
export const THIRD = 'The deploy script for the staging cluster runs on CircleCI nightly now.';
export const AGAIN = 'The deploy script for the staging cluster runs on Jenkins nightly again.';

export const root = (): string => makeRoot('supersede-pass', { config: { replay: { count: 0 } } });

export const iso = (ageMinutes: number): string =>
  new Date(FIXED_NOW.getTime() - ageMinutes * MINUTE_MS).toISOString();

export function fact(text: string, ageMinutes: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = iso(ageMinutes);
  const row = createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic });
  return { ...row, created: at, lastRetrieved: at, validFrom: at, ...extra };
}
