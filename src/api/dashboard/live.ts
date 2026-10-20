// What the dashboard shows: live memories by origin project, under the wire's layer and band names.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { isQuarantineScope } from '../../domain/trust/quarantine.js';
import type { DashboardChip, Origin } from '../../store/port/dashboard-reads.js';
import type { Band, Layer, ProjectKind } from './types.js';

export const LAYERS: readonly Layer[] = ['buffer', 'episodic', 'semantic', 'trace'];
// Wire order of `Band`, and the order the mockup sorts bands in.
export const BANDS: readonly Band[] = ['pinned', 'strong', 'fading', 'atRisk'];

export type Chip = DashboardChip;

/** The one predicate for "shown on the dashboard": not superseded, not archived, not quarantined. */
export function isLiveMemory(entry: Pick<MemoryEntry, 'supersededBy' | 'kind' | 'scope'>): boolean {
  return !entry.supersededBy && (entry.kind === 'raw' || entry.kind === 'distilled') && !isQuarantineScope(entry.scope);
}

/** Wire key, display name and kind of a project. */
export interface ProjectIdentity {
  key: string;
  name: string;
  kind: ProjectKind;
}

/** Wire key, display name and kind for an `origin_project` value. */
export function projectIdentity(origin: Origin | undefined): ProjectIdentity {
  if (origin === '') return { key: 'global', name: 'Global', kind: 'global' };
  if (origin === null || origin === undefined) return { key: 'unassigned', name: 'Unassigned', kind: 'unassigned' };
  return { key: `p:${origin}`, name: origin, kind: 'project' };
}

/** The `origin_project` value a wire key names, or undefined for a key no project has. */
export function originOfKey(key: string): Origin | undefined {
  if (key === 'global') return '';
  if (key === 'unassigned') return null;
  return key.startsWith('p:') && key.length > 2 ? key.slice(2) : undefined;
}

/** Strengths go on the wire at three decimals. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
