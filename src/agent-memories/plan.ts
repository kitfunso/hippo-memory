// What one sync does to one container's rows: a pure function of the items read and the rows found (plan design 6).

export interface PlanItem {
  readonly key: string;
  readonly hash: string;
  /** Read but not storable: under 10 characters, a secret, or a rejected value. */
  readonly refused: boolean;
}

export interface LiveRow {
  readonly id: string;
  readonly key: string;
  readonly hash: string;
  /** Carries the tool's tag; an untagged row is one the user restored, or a pin whose note went. */
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
  /** Snapshots that are readable and not superseded. */
  readonly dormant: readonly DormantRow[];
  /** Legacy rows a new row of the key replaces (plan design 10, second round). */
  readonly legacy?: ReadonlyMap<string, readonly string[]>;
  /** Asked only when a row would be written: the text is already stored live by another path. */
  readonly isDuplicate: (item: PlanItem) => boolean;
}

export interface PlannedWrite {
  readonly key: string;
  readonly hash: string;
  readonly supersedes: readonly string[];
}

export interface ContainerPlan {
  readonly unchanged: number;
  /** Untagged rows whose tag goes back on. */
  readonly retag: readonly string[];
  /** Tagged rows superseded by the row kept for their key. */
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
  const draft: Draft = { unchanged: 0, retag: [], collapse: [], writes: [], fresh: [], restores: [], setAside: [], duplicates: 0, refused: 0 };
  for (const item of input.items) planItem(input, item, live.get(item.key) ?? [], dormant.get(item.key) ?? [], draft);

  const read = new Set([...input.items.map((i) => i.key), ...input.skipped]);
  const gone = new Map<string, string[]>();
  for (const [key, rows] of live) {
    const tagged = rows.filter((r) => r.tagged).map((r) => r.id);
    if (!read.has(key) && tagged.length > 0) gone.set(key, tagged);
  }
  if (input.textKeyed) pairEdits(gone, draft.fresh);
  for (const ids of gone.values()) draft.setAside.push(...ids);

  const { fresh, ...plan } = draft;
  return { ...plan, writes: [...plan.writes, ...fresh] };
}

function planItem(input: PlanInput, item: PlanItem, rows: readonly LiveRow[], snaps: readonly DormantRow[], draft: Draft): void {
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
    if (kept.tagged && others.length === 0) draft.unchanged++;
    return;
  }
  const legacy = input.legacy?.get(item.key) ?? [];
  if (rows.length > 0) {
    if (input.isDuplicate(item)) {
      draft.duplicates++;
      draft.setAside.push(...tagged.map((r) => r.id));
    } else {
      draft.writes.push({ key: item.key, hash: item.hash, supersedes: [...rows.map((r) => r.id), ...legacy] });
    }
    return;
  }
  const snap = newestSnapshot(snaps.filter((s) => s.hash === item.hash));
  if (snap !== undefined) draft.restores.push({ key: item.key, dormantId: snap.id });
  else if (input.isDuplicate(item)) draft.duplicates++;
  else draft.fresh.push({ key: item.key, hash: item.hash, supersedes: legacy });
}

/** A single-file store keys items by text, so an edit reads as one key gone and one new under the same heading. */
function pairEdits(gone: Map<string, string[]>, fresh: PlannedWrite[]): void {
  const goneBy = groupBy([...gone.keys()], headingOf);
  const freshBy = groupBy(fresh.map((w, i) => ({ w, i })), (f) => headingOf(f.w.key));
  for (const [heading, keys] of goneBy) {
    const news = freshBy.get(heading) ?? [];
    if (keys.length !== 1 || news.length !== 1) continue;
    const { w, i } = news[0];
    fresh[i] = { ...w, supersedes: [...w.supersedes, ...(gone.get(keys[0]) ?? [])] };
    gone.delete(keys[0]);
  }
}

function headingOf(key: string): string {
  return key.slice(0, Math.max(0, key.lastIndexOf('/')));
}

// Byte order, as memory.ts's timestamp note asks: localeCompare may skip the ISO punctuation.
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
  /** The file name its `claude-memory:<file>` source names. */
  readonly file: string;
  /** duplicateKey of its content. */
  readonly textKey: string;
}

export interface LegacyTarget {
  /** Opaque to this function: the sync's handle on one container's item. */
  readonly ref: string;
  readonly file: string;
  readonly textKey: string;
}

export interface LegacyMatch {
  /** Legacy row id to the target whose key it takes, keeping its id and history (same text: a renamed note too). */
  readonly adopt: ReadonlyMap<string, string>;
  /** Target ref to the legacy row a new row of that target replaces (different text, one legacy row of that file). */
  readonly replace: ReadonlyMap<string, string>;
}

/** Plan design 10: same text first, then one legacy row per file name; anything else is left to decay. */
export function matchLegacy(rows: readonly LegacyRow[], targets: readonly LegacyTarget[]): LegacyMatch {
  const byText = new Map<string, string>();
  for (const t of targets) if (!byText.has(t.textKey)) byText.set(t.textKey, t.ref);
  const adopt = new Map<string, string>();
  for (const row of rows) {
    const ref = byText.get(row.textKey);
    if (ref !== undefined) adopt.set(row.id, ref);
  }
  const adoptedRefs = new Set(adopt.values());
  const leftByFile = groupBy(rows.filter((r) => !adopt.has(r.id)), (r) => r.file);
  const targetsByFile = groupBy(targets.filter((t) => !adoptedRefs.has(t.ref)), (t) => t.file);
  const replace = new Map<string, string>();
  for (const [file, left] of leftByFile) {
    const matches = targetsByFile.get(file) ?? [];
    if (left.length === 1 && matches.length === 1) replace.set(matches[0].ref, left[0].id);
  }
  return { adopt, replace };
}
