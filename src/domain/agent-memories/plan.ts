import { headingOfKey } from './keys.js';
import { fileOfKey, isPartKey } from './source.js';

export interface PlanItem {
  readonly key: string;
  readonly hash: string;
  readonly refused: boolean;
}

export interface LiveRow {
  readonly id: string;
  readonly key: string;
  readonly hash: string;
  readonly tagged: boolean;
  readonly created: string;
}

export interface DormantRow {
  readonly id: string;
  readonly key: string;
  readonly hash: string;
  readonly dormantAt: string;
}

export interface PlanInput {
  readonly textKeyed: boolean;
  readonly items: readonly PlanItem[];
  readonly skipped: readonly string[];
  readonly live: readonly LiveRow[];
  readonly dormant: readonly DormantRow[];
  readonly legacy?: ReadonlyMap<string, readonly string[]>;
  readonly isDuplicate: (item: PlanItem) => boolean;
}

export interface PlannedWrite {
  readonly key: string;
  readonly hash: string;
  readonly supersedes: readonly string[];
  readonly carry?: readonly string[];
}

export interface ContainerPlan {
  readonly unchanged: number;
  readonly retag: readonly string[];
  readonly collapse: readonly { readonly id: string; readonly by: string }[];
  readonly writes: readonly PlannedWrite[];
  readonly restores: readonly { readonly key: string; readonly dormantId: string }[];
  readonly setAside: readonly string[];
  readonly duplicates: number;
  readonly refused: number;
}

interface Draft {
  unchanged: number;
  retag: string[];
  collapse: { id: string; by: string }[];
  writes: PlannedWrite[];
  fresh: PlannedWrite[];
  restores: { key: string; dormantId: string }[];
  setAside: string[];
  duplicates: number;
  refused: number;
}

export function planContainer(input: PlanInput): ContainerPlan {
  const live = groupByKey(input.live);
  const dormant = groupByKey(input.dormant);
  const draft: Draft = {
    unchanged: 0,
    retag: [],
    collapse: [],
    writes: [],
    fresh: [],
    restores: [],
    setAside: [],
    duplicates: 0,
    refused: 0,
  };
  for (const item of input.items) {
    planItem({
      input,
      item,
      rows: live.get(item.key) ?? [],
      snaps: dormant.get(item.key) ?? [],
      draft,
    });
  }

  const read = new Set(input.items.map((i) => i.key));
  const unread = new Set(input.skipped);
  const gone = new Map<string, string[]>();
  for (const [key, rows] of live) {
    const tagged = rows.filter((r) => r.tagged).map((r) => r.id);
    if (!read.has(key) && !unread.has(fileOfKey(key)) && tagged.length > 0) gone.set(key, tagged);
  }
  pairCapCrossings(gone, draft.fresh);
  pairEdits(gone, draft.fresh, input.textKeyed ? () => true : isPartKey);
  for (const ids of gone.values()) draft.setAside.push(...ids);

  const { fresh, ...plan } = draft;
  return { ...plan, writes: [...plan.writes, ...fresh] };
}

interface PlanItemOptions {
  readonly input: PlanInput;
  readonly item: PlanItem;
  readonly rows: readonly LiveRow[];
  readonly snaps: readonly DormantRow[];
  readonly draft: Draft;
}

function planItem({ input, item, rows, snaps, draft }: PlanItemOptions): void {
  const tagged = rows.filter((r) => r.tagged);
  if (item.refused) {
    draft.refused++;
    draft.setAside.push(...tagged.map((r) => r.id));
    return;
  }
  const same = rows.filter((r) => r.hash === item.hash);
  if (same.length > 0) {
    const kept = newestRow(same.filter((r) => r.tagged)) ?? newestRow(same);
    if (kept === undefined) return;
    if (!kept.tagged) draft.retag.push(kept.id);
    const others = tagged.filter((r) => r.id !== kept.id);
    draft.collapse.push(...others.map((r) => ({ id: r.id, by: kept.id })));
    const stale = input.legacy?.get(item.key) ?? [];
    draft.collapse.push(...stale.map((id) => ({ id, by: kept.id })));
    if (kept.tagged && others.length === 0) draft.unchanged++;
    return;
  }
  const legacy = input.legacy?.get(item.key) ?? [];
  if (rows.length > 0) {
    if (input.isDuplicate(item)) {
      draft.duplicates++;
      draft.setAside.push(...tagged.map((r) => r.id));
    } else {
      draft.writes.push({
        key: item.key,
        hash: item.hash,
        supersedes: [...rows.map((r) => r.id), ...legacy],
      });
    }
    return;
  }
  const snap = newestSnapshot(snaps.filter((s) => s.hash === item.hash));
  if (snap !== undefined) draft.restores.push({ key: item.key, dormantId: snap.id });
  else if (input.isDuplicate(item)) draft.duplicates++;
  else draft.fresh.push({ key: item.key, hash: item.hash, supersedes: legacy });
}

function pairCapCrossings(gone: Map<string, string[]>, fresh: PlannedWrite[]): void {
  for (const [file, keys] of groupBy([...gone.keys()], fileOfKey)) {
    const i = fresh.findIndex((w) => fileOfKey(w.key) === file);
    if (i < 0 || (!keys.includes(file) && fresh[i].key !== file)) continue;
    const ids = keys.flatMap((key) => gone.get(key) ?? []);
    fresh[i] = { ...fresh[i], supersedes: [...fresh[i].supersedes, ...ids], carry: ids };
    for (const key of keys) gone.delete(key);
  }
}

function pairEdits(
  gone: Map<string, string[]>,
  fresh: PlannedWrite[],
  textKey: (key: string) => boolean,
): void {
  const goneBy = groupBy([...gone.keys()].filter(textKey), headingOfKey);
  const freshBy = groupBy(
    fresh.map((w, i) => ({ w, i })).filter((f) => textKey(f.w.key)),
    (f) => headingOfKey(f.w.key),
  );
  for (const [heading, keys] of goneBy) {
    const news = freshBy.get(heading) ?? [];
    if (keys.length !== 1 || news.length !== 1) continue;
    const { w, i } = news[0];
    fresh[i] = { ...w, supersedes: [...w.supersedes, ...(gone.get(keys[0]) ?? [])] };
    gone.delete(keys[0]);
  }
}

const byteOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function newestRow(rows: readonly LiveRow[]): LiveRow | undefined {
  return [...rows].sort((a, b) => byteOrder(b.created, a.created) || byteOrder(b.id, a.id))[0];
}

function newestSnapshot(rows: readonly DormantRow[]): DormantRow | undefined {
  return [...rows].sort((a, b) => byteOrder(b.dormantAt, a.dormantAt) || byteOrder(b.id, a.id))[0];
}

function groupByKey<T extends { readonly key: string }>(rows: readonly T[]): Map<string, T[]> {
  return groupBy(rows, (r) => r.key);
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const list = out.get(key);
    if (list) list.push(value);
    else out.set(key, [value]);
  }
  return out;
}

export interface LegacyRow {
  readonly id: string;
  readonly file: string;
  readonly textKey: string;
}

export interface LegacyTarget {
  readonly ref: string;
  readonly file: string;
  readonly note: string;
  readonly textKey: string;
}

export interface LegacyMatch {
  readonly adopt: ReadonlyMap<string, string>;
  readonly replace: ReadonlyMap<string, readonly string[]>;
}

/** Same text first, then every row of a file name only one note has, given to its first target;
 * anything else is left to decay. */
export function matchLegacy(
  rows: readonly LegacyRow[],
  targets: readonly LegacyTarget[],
): LegacyMatch {
  const byText = new Map<string, string>();
  for (const t of targets) if (!byText.has(t.textKey)) byText.set(t.textKey, t.ref);
  const adopt = new Map<string, string>();
  for (const row of rows) {
    const ref = byText.get(row.textKey);
    if (ref !== undefined) adopt.set(row.id, ref);
  }
  const adoptedRefs = new Set(adopt.values());
  const leftByFile = groupBy(
    rows.filter((r) => !adopt.has(r.id)),
    (r) => r.file,
  );
  const targetsByFile = groupBy(
    targets.filter((t) => !adoptedRefs.has(t.ref)),
    (t) => t.file,
  );
  const replace = new Map<string, string[]>();
  for (const [file, left] of leftByFile) {
    const matches = targetsByFile.get(file) ?? [];
    if (new Set(matches.map((t) => t.note)).size !== 1) continue;
    replace.set(
      matches[0].ref,
      left.map((r) => r.id),
    );
  }
  return { adopt, replace };
}
