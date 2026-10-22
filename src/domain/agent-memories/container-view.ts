// A container's live rows as they will stand once its moves run: the legacy adoptions and the moves from the project's
// earlier names are planned as steps, and applied to the rows read, as the store will apply them.
import type { MemoryEntry, StrengthOptions } from '../../base/memory/memory.js';
import type { AgentMemoryTool } from '../../base/memory/agent-memory-tools.js';
import type { ImportStep, PlannedRow } from '../../store/port/agent-import.js';
import type { DormantSnapshot } from '../../store/port/types.js';
import { itemSource } from './source.js';
import type { Container, ImportStore } from './types.js';

export interface StoreSession {
  readonly store: ImportStore;
  readonly tenantId: string;
  readonly baseHalfLifeDays: number;
  /** How a revived row is scored: the eval switches and the root's loss-aversion ratio. */
  readonly strength: StrengthOptions;
  /** Stamped on written rows; undefined lets the store stamp its own project. */
  readonly originProject: string | undefined;
  /** Design 6: in the global store only rows visible where the new row goes count as duplicates; null counts all. */
  readonly visible: readonly string[] | null;
  /** Legacy rows about to take a note's key, which stop counting as text another path stored. */
  readonly adopted: ReadonlySet<string>;
  readonly dryRun: boolean;
}

export interface ContainerWork {
  readonly tool: AgentMemoryTool;
  readonly container: Container;
  /** `containerPrefix(tool, containerId)`: every row of the container has a source starting with it. */
  readonly prefix: string;
  /** Legacy rows that take an item's key as they are, by key. */
  readonly adopt: ReadonlyMap<string, readonly MemoryEntry[]>;
  /** Legacy rows a new row of the key supersedes, by key (second round). */
  readonly replace: ReadonlyMap<string, readonly MemoryEntry[]>;
  /** This container's prefixes under the project's earlier names; their rows move here, so a new id imports nothing
   * twice. */
  readonly legacyPrefixes: readonly string[];
}

export interface ContainerView {
  /** The live rows under the prefix once the moves run, oldest first as the store reads them. */
  readonly live: readonly MemoryEntry[];
  /** Dormant snapshots the moves bring under the prefix, as they will stand. */
  readonly movedDormant: readonly DormantSnapshot[];
  /** Every live row under the prefix and the earlier ones, as read: what the apply checks still stands. */
  readonly read: readonly PlannedRow[];
  /** The adoptions and moves, in the order the store runs them. */
  readonly steps: readonly ImportStep[];
}

interface Draft {
  readonly live: MemoryEntry[];
  readonly movedDormant: DormantSnapshot[];
  readonly steps: ImportStep[];
}

export async function readContainer(s: StoreSession, w: ContainerWork): Promise<ContainerView> {
  const reads = s.store.agentImport;
  const live = await reads.liveBySourcePrefix(s.tenantId, w.prefix);
  const read = [...live];
  const draft: Draft = { live: [...live], movedDormant: [], steps: [] };
  await adoptLegacy(s, w, draft);
  for (const old of w.legacyPrefixes) {
    const rows = await reads.liveBySourcePrefix(s.tenantId, old);
    read.push(...rows);
    await adoptPrefix(s, w, { old, rows }, draft);
  }
  return {
    ...draft,
    live: oldestFirst(draft.live),
    read: read.map((row) => ({ id: row.id, source: row.source, tagged: row.tags.includes(w.tool.tag) })),
  };
}

/** Same text as a current note: the legacy row takes the note's key, keeping its id, recall count and outcomes. */
async function adoptLegacy(s: StoreSession, w: ContainerWork, draft: Draft): Promise<void> {
  const standing = await standingLegacy(s, [...w.adopt.values()].flat());
  for (const [key, rows] of w.adopt) {
    const item = w.container.items.find((i) => i.key === key);
    if (item === undefined) continue;
    const source = itemSource(w.prefix, key, item.text);
    for (const { id, source: from } of rows) {
      const row = standing.get(id);
      if (row === undefined) continue;
      draft.steps.push({ kind: 'adopt', id, from, to: source });
      draft.live.push({ ...row, source });
    }
  }
}

/** The legacy rows still live at the source the match read, as they stand now: another sync may have adopted one. */
async function standingLegacy(s: StoreSession, rows: readonly MemoryEntry[]): Promise<Map<string, MemoryEntry>> {
  const from = new Map(rows.map((row) => [row.id, row.source]));
  const out = new Map<string, MemoryEntry>();
  for (const row of await s.store.entriesByIds([...from.keys()], s.tenantId)) {
    if (!row.supersededBy && row.source === from.get(row.id)) out.set(row.id, row);
  }
  return out;
}

/** Rows filed under an earlier project name keep their id and history; dormant ones move too, scanned only until this
 * prefix holds live rows. */
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
  for (const snap of await s.store.agentImport.dormantBySourcePrefix(s.tenantId, old)) {
    const source = w.prefix + snap.entry.source.slice(old.length);
    draft.movedDormant.push({
      ...snap,
      entry: { ...snap.entry, source, originProject: origin ?? snap.entry.originProject },
    });
  }
}

// Byte order on created then id, as the store pages rows; localeCompare may skip the ISO punctuation.
const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function oldestFirst(rows: readonly MemoryEntry[]): MemoryEntry[] {
  return [...rows].sort((a, b) => byteOrder(a.created, b.created) || byteOrder(a.id, b.id));
}
