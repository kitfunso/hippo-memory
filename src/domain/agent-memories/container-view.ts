import type { MemoryEntry } from '../../base/memory/entry.js';
import type { StrengthModel } from '../../base/memory/strength.js';
import type { AgentMemoryTool } from '../../base/memory/agent-memory-tools.js';
import type { ImportStep, PlannedRow } from '../../base/ports/store/agent-import.js';
import type { DormantSnapshot, EntryCursor } from '../../base/ports/store/types.js';
import { READ_PAGE_ROWS, readAll } from '../../base/util/pages.js';
import { itemSource } from './source.js';
import type { Container, ImportStore } from './types.js';
import { isSuperseded } from '../../base/memory/liveness.js';

export interface StoreSession {
  readonly store: ImportStore;
  readonly tenantId: string;
  readonly baseHalfLifeDays: number;
  readonly strength: StrengthModel;
  readonly now: Date;
  readonly originProject: string | undefined;
  readonly visible: readonly string[] | null;
  readonly adopted: ReadonlySet<string>;
  readonly dryRun: boolean;
}

export interface ContainerWork {
  readonly tool: AgentMemoryTool;
  readonly container: Container;
  readonly prefix: string;
  readonly adopt: ReadonlyMap<string, readonly MemoryEntry[]>;
  readonly replace: ReadonlyMap<string, readonly MemoryEntry[]>;
  readonly legacyPrefixes: readonly string[];
}

export interface ContainerView {
  readonly live: readonly MemoryEntry[];
  readonly movedDormant: readonly DormantSnapshot[];
  readonly read: readonly PlannedRow[];
  readonly steps: readonly ImportStep[];
}

interface Draft {
  readonly live: MemoryEntry[];
  readonly movedDormant: DormantSnapshot[];
  readonly steps: ImportStep[];
}

/** The tenant's live rows whose source starts with `prefix`, oldest first. */
export async function liveUnder(
  store: Pick<ImportStore, 'entriesWhere'>,
  tenantId: string,
  prefix: string,
): Promise<MemoryEntry[]> {
  const under = { tenantId, sourcePrefix: prefix, live: true } as const;
  return readAll((after?: EntryCursor) =>
    store.entriesWhere(under, { limit: READ_PAGE_ROWS, after }),
  );
}

export async function readContainer(s: StoreSession, w: ContainerWork): Promise<ContainerView> {
  const live = await liveUnder(s.store, s.tenantId, w.prefix);
  const read = [...live];
  const draft: Draft = { live: [...live], movedDormant: [], steps: [] };
  await adoptLegacy(s, w, draft);
  for (const old of w.legacyPrefixes) {
    const rows = await liveUnder(s.store, s.tenantId, old);
    read.push(...rows);
    await adoptPrefix(s, w, { old, rows }, draft);
  }
  return {
    ...draft,
    live: oldestFirst(draft.live),
    read: read.map((row) => ({
      id: row.id,
      source: row.source,
      tagged: row.tags.includes(w.tool.tag),
    })),
  };
}

async function adoptLegacy(s: StoreSession, w: ContainerWork, draft: Draft): Promise<void> {
  const standing = await standingLegacy(s, [...w.adopt.values()].flat());
  for (const [key, rows] of w.adopt) {
    const item = w.container.items.find((i) => i.key === key);
    if (item === undefined) continue;
    const source = itemSource(w.prefix, { key, text: item.text });
    for (const { id, source: from } of rows) {
      const row = standing.get(id);
      if (row === undefined) continue;
      draft.steps.push({ kind: 'adopt', id, from, to: source });
      draft.live.push({ ...row, source });
    }
  }
}

async function standingLegacy(
  s: StoreSession,
  rows: readonly MemoryEntry[],
): Promise<Map<string, MemoryEntry>> {
  const from = new Map(rows.map((row) => [row.id, row.source]));
  const out = new Map<string, MemoryEntry>();
  for (const row of await s.store.entriesByIds([...from.keys()], s.tenantId)) {
    if (!isSuperseded(row) && row.source === from.get(row.id)) out.set(row.id, row);
  }
  return out;
}

async function adoptPrefix(
  s: StoreSession,
  w: ContainerWork,
  { old, rows }: { readonly old: string; readonly rows: readonly MemoryEntry[] },
  draft: Draft,
): Promise<void> {
  const origin = s.originProject ?? null;
  for (const row of rows) {
    const to = w.prefix + row.source.slice(old.length);
    draft.steps.push({ kind: 'move', id: row.id, to, origin });
    draft.live.push({ ...row, source: to, originProject: origin ?? row.originProject });
  }
  if (rows.length === 0 && (w.container.items.length === 0 || draft.live.length > 0)) return;
  draft.steps.push({ kind: 'moveDormant', from: old, to: w.prefix, origin });
  for (const snap of await s.store.projectTags.dormantWhere({
    tenantId: s.tenantId,
    sourcePrefix: old,
  })) {
    const source = w.prefix + snap.entry.source.slice(old.length);
    draft.movedDormant.push({
      ...snap,
      entry: { ...snap.entry, source, originProject: origin ?? snap.entry.originProject },
    });
  }
}

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function oldestFirst(rows: readonly MemoryEntry[]): MemoryEntry[] {
  return [...rows].sort((a, b) => byteOrder(a.created, b.created) || byteOrder(a.id, b.id));
}
