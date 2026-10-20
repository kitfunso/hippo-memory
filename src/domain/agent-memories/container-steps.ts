// A container plan as the store's steps, the rows each writes built here, and the tally read back from the outcomes.
import { Layer, calculateStrength, createMemory, type MemoryEntry } from '../../base/memory/memory.js';
import type { ImportStep, StepOutcome } from '../../store/port/agent-import.js';
import type { DormantSnapshot } from '../../store/port/types.js';
import type { ContainerWork, StoreSession } from './container-view.js';
import type { ContainerPlan } from './plan.js';
import type { Tally } from './report.js';
import { itemSource, splitSource, storedText } from './source.js';
import type { MemoryItem } from './types.js';

/** What a plan's steps read beside the plan: the rows by id as they will stand, and the dormant snapshots by id. */
export interface PlanRows {
  readonly live: ReadonlyMap<string, MemoryEntry>;
  readonly dormant: ReadonlyMap<string, DormantSnapshot>;
}

export function planSteps(s: StoreSession, w: ContainerWork, plan: ContainerPlan, rows: PlanRows): ImportStep[] {
  const items = new Map(w.container.items.map((item) => [item.key, item]));
  const item = (key: string): MemoryItem => found(items.get(key), `planned key ${key} was not read`);
  const live = (id: string): MemoryEntry => found(rows.live.get(id), `planned row ${id} was not in the lookup`);
  return [
    ...plan.retag.map((id): ImportStep => ({ kind: 'retag', id })),
    ...plan.collapse.map(({ id, by }): ImportStep => ({ kind: 'supersede', id, by })),
    ...plan.writes.map((write): ImportStep => ({
      kind: 'write',
      entry: newRow(s, w, item(write.key)),
      supersedes: write.supersedes,
    })),
    ...plan.restores.map(({ key, dormantId }): ImportStep => ({
      kind: 'restore',
      dormantId,
      revived: revived(s, w, found(rows.dormant.get(dormantId), `planned snapshot ${dormantId} was not read`)),
      fresh: newRow(s, w, item(key)),
    })),
    ...plan.setAside.map((id): ImportStep => ({
      kind: 'setAside',
      id,
      why: items.has(splitSource(live(id).source, w.prefix).key) ? 'note-changed' : 'note-gone',
    })),
  ];
}

function found<T>(value: T | undefined, missing: string): T {
  if (value === undefined) throw new Error(`agent memory sync: ${missing}`);
  return value;
}

function newRow(s: StoreSession, w: ContainerWork, item: MemoryItem): MemoryEntry {
  const base = createMemory(storedText(item.text), {
    layer: Layer.Episodic,
    tags: [w.tool.tag],
    source: itemSource(w.prefix, item.key, item.text),
    confidence: 'observed',
    kind: 'distilled',
    tenantId: s.tenantId,
    baseHalfLifeDays: s.baseHalfLifeDays,
  });
  // The note's own time when it is earlier than now; the loader reads any form but toISOString as drift.
  const created = Number.isFinite(item.updatedAt)
    ? new Date(Math.min(item.updatedAt, Date.parse(base.created))).toISOString()
    : base.created;
  const origin = s.originProject === undefined ? {} : { originProject: s.originProject };
  return { ...base, created, validFrom: created, ...origin };
}

/** The snapshot's row as if just recalled, carrying the tool's tag once. */
function revived(s: StoreSession, w: ContainerWork, snap: DormantSnapshot): MemoryEntry {
  const now = new Date();
  const tags = Array.isArray(snap.entry.tags) ? snap.entry.tags.filter((t) => t !== w.tool.tag) : [];
  const row: MemoryEntry = {
    ...createMemory('dormant snapshot defaults', { baseHalfLifeDays: s.baseHalfLifeDays }),
    ...snap.entry,
    tags: [...tags, w.tool.tag],
    lastRetrieved: now.toISOString(),
  };
  return { ...row, strength: calculateStrength(row, now, s.strength) };
}

/** `tally` plus what each step did. */
export function addOutcomes(tally: Tally, steps: readonly ImportStep[], outcomes: readonly StepOutcome[]): void {
  steps.forEach((step, i) => addOutcome(tally, step, outcomes[i]));
}

function addOutcome(tally: Tally, step: ImportStep, outcome: StepOutcome): void {
  if (step.kind === 'adopt') tally.adopted++;
  else if (step.kind === 'move') tally.renamed++;
  else if (step.kind === 'retag') tally.retagged++;
  else if (step.kind === 'supersede' && outcome === 'done') tally.collapsed++;
  else if (step.kind === 'write') addWrite(tally, outcome, step.supersedes.length > 0 ? 'replaced' : 'imported');
  else if (step.kind === 'restore' && outcome === 'restored') tally.restored++;
  else if (step.kind === 'restore') addWrite(tally, outcome, 'imported');
  else if (step.kind === 'setAside') tally[outcome === 'untagged' ? 'untagged' : 'setAside']++;
}

/** A write the gate refused is counted by why; the gate's worth check is off for imported notes. */
function addWrite(tally: Tally, outcome: StepOutcome, written: 'imported' | 'replaced'): void {
  tally[outcome === 'written' ? written : outcome === 'skipped:rejected' ? 'rejected' : 'secret']++;
}
