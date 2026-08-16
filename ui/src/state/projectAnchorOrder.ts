/**
 * v0.29 (E5) — Append-only persisted ordering of project (path:*) tags.
 *
 * Stable across sessions: once a project gets an index, that index NEVER
 * moves. New project tags get the next-after-max index. Deleted tags retain
 * their slot. Combined with golden-angle anchor packing in projectAnchors.ts,
 * existing tags' anchor positions are byte-identical pre/post any new-tag
 * addition — the structural fix for the E4 R2 mass-resettle bug.
 *
 * STORAGE_KEY versioning: bump to "...:v2" if the persisted schema
 * changes; old v1 keys become orphaned (not migrated) — acceptable since
 * the data is purely UI-state with no canonical value.
 */

const STORAGE_KEY = "hippo:projectAnchorOrder:v1";

export interface ProjectAnchorOrder {
  /** Tag → its persistent index (0-based). Stable across sessions. */
  indexByTag: Map<string, number>;
  /** Highest index assigned. Next new tag gets nextIndex (= maxIndex + 1). */
  nextIndex: number;
}

const EMPTY: ProjectAnchorOrder = { indexByTag: new Map(), nextIndex: 0 };

/** True when a browser `window` global is present (vs. Node/SSR). Avoids a
 * bare `typeof window` check by testing globalThis instead — same "never
 * throws even when the global is undeclared" safety, no `typeof` operator. */
function hasWindow(): boolean {
  return "window" in globalThis;
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isFiniteNumber<T>(value: T): value is T & number {
  if (typeof value !== "number") return false;
  return Number.isFinite(value);
}

function isPersistedTagEntry<T>(value: T): value is T & [string, number] {
  return (
    Array.isArray(value) && value.length === 2 && isString(value[0]) && isFiniteNumber(value[1])
  );
}

type PersistedAnchorOrderPayload = { tags: Array<[string, number]>; nextIndex: number };

/** Validate a JSON.parse() result into the persisted-order shape, or null
 * on shape mismatch (legacy / corrupted / hand-edited payload). */
function parsePersistedAnchorOrder<T>(parsed: T): PersistedAnchorOrderPayload | null {
  if (!parsed) return null;
  // SAFETY: `parsed` is confirmed truthy above, so it is neither null nor
  // undefined — the only values whose property access throws. Reading
  // `.tags`/`.nextIndex` off any other JSON.parse() output (string, number,
  // boolean, array, or object) safely yields `undefined` when absent.
  const candidate = parsed as { tags?: unknown; nextIndex?: unknown };
  const { tags, nextIndex } = candidate;
  if (!Array.isArray(tags) || !isFiniteNumber(nextIndex)) return null;
  // v2.1: tighten inner-tuple shape check. new Map([['hello']]) does NOT
  // throw — it silently produces {key:'hello', value:undefined} and the
  // undefined index then NaN-propagates through golden-angle math. Reject
  // any entry that isn't exactly [string, finite-number].
  if (!tags.every(isPersistedTagEntry)) return null;
  return { tags, nextIndex };
}

/**
 * Load from localStorage. Returns empty on first run, parse error, OR
 * shape mismatch (legacy / corrupted / hand-edited payload). Two-layer
 * defense: try/catch for JSON.parse + explicit shape validation before
 * constructing the Map (which would throw OR silently corrupt on
 * non-iterable / non-tuple `tags`).
 */
export function loadProjectAnchorOrder(): ProjectAnchorOrder {
  if (!hasWindow()) return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    const valid = parsePersistedAnchorOrder(parsed);
    if (valid === null) return EMPTY;
    return {
      indexByTag: new Map(valid.tags),
      nextIndex: valid.nextIndex,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Persist to localStorage. Silent no-op if window/storage unavailable.
 * Layout still works without persistence; new tags get re-assigned per
 * session (locally consistent within the session, just not across them).
 */
export function saveProjectAnchorOrder(order: ProjectAnchorOrder): void {
  if (!hasWindow()) return;
  try {
    const serialized = JSON.stringify({
      tags: [...order.indexByTag.entries()],
      nextIndex: order.nextIndex,
    });
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // localStorage may be full or disabled — silently skip.
  }
}

/**
 * Reconcile current project tags with the persisted ordering.
 * - Tags already in ordering: keep their existing index.
 * - New tags: assigned nextIndex (alpha-sorted batch order), nextIndex++.
 * - Tags no longer in current set: index retained in ordering but unused.
 *
 * Returns SAME order object reference when nothing changed (reference
 * equality lets caller skip the save call).
 */
export function reconcileProjectOrder(
  currentTags: readonly string[],
  order: ProjectAnchorOrder,
): ProjectAnchorOrder {
  const sortedTags = [...currentTags].sort(); // deterministic add order
  const indexByTag = new Map(order.indexByTag);
  let nextIndex = order.nextIndex;
  let changed = false;
  for (const tag of sortedTags) {
    if (!indexByTag.has(tag)) {
      indexByTag.set(tag, nextIndex);
      nextIndex++;
      changed = true;
    }
  }
  return changed ? { indexByTag, nextIndex } : order;
}

/**
 * @internal Reset for tests / future "reset layout" affordance. Not wired
 * into product code in this episode — exported only so tests can isolate
 * state between runs. v0.3.0 will wire a button.
 */
export function clearProjectAnchorOrder(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
