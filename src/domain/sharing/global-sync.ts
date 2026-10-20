// Copying the global store's memories down into a local store.

import { BadRequestError } from '../../base/errors/api-errors.js';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../../base/memory/agent-memory-tools.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { chunked } from '../../base/util/chunked.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { classifyOriginProject, type ProjectIdentity } from '../../base/scope/project-identity.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { embedAll, folderIndex, type ConfiguredFolder } from '../search/embed-memories.js';
import { log } from '../../base/util/log.js';
import type { EntryTextKey, Sharing } from '../../store/port.js';
import { logEmbedAllFailure } from './search-both.js';
import { textKeyPages, type SharingStore } from './text-keys.js';

/**
 * Copy all global memories into the local store, skipping entries that already exist locally by ID or text (promote and
 * share copy under a new ID). The caller's request scope keeps it to one open per store.
 * Returns the count of newly copied entries. */
export async function syncGlobalToLocal(
  into: ConfiguredFolder<SharingStore>,
  global: { readonly store: SharingStore },
  opts: { includeCrossProject?: boolean } = {},
): Promise<number> {
  const home = await into.store.folderFiles.home();
  if (home.shared) {
    throw new BadRequestError(
      `Refusing to sync into ${home.folder}: a shared store takes no copies of a personal global store, ` +
        `whose rows would reach every member.`,
    );
  }
  if (!(await global.store.folderFiles.home()).exists) return 0;

  return copyMissingRows(into, global.store, { project: home.project, includeCrossProject: opts.includeCrossProject });
}

const textKey = (e: { tenantId: string; content: string }): string => `${e.tenantId}\n${e.content}`;

/** Global rows of every tenant that the local store holds by neither id nor tenant and text, oldest first; each page
 * asks the local store about its own ids and texts only. */
async function missingRows(local: Sharing, from: Sharing): Promise<EntryTextKey[]> {
  const missing: EntryTextKey[] = [];
  for await (const page of textKeyPages(from, ALL_TENANTS)) {
    const taken = new Set(await local.takenIds(page.map((k) => k.id)));
    // Only the global store's user pass sets an imported note's row aside, so a copy would outlive the note.
    const open = page.filter((k) => !taken.has(k.id) && !k.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX));
    if (open.length === 0) continue;
    const held = await local.textKeysHolding(
      ALL_TENANTS,
      open.map((k) => k.content),
    );
    const heldKeys = new Set(held.map(textKey));
    missing.push(...open.filter((k) => !heldKeys.has(textKey(k))));
  }
  return missing;
}

interface CopyRules {
  /** The local store's project, which decides what counts as another project's row. */
  readonly project: ProjectIdentity;
  readonly includeCrossProject?: boolean;
}

interface Copies {
  readonly copies: MemoryEntry[];
  /** The texts a later row held again, left out behind the first. */
  readonly twins: Set<string>;
}

/** The rows to copy, in order: one per text, never a secret, and another project's only when asked. */
function copiesOf(
  candidates: readonly EntryTextKey[],
  byId: ReadonlyMap<string, MemoryEntry>,
  rules: CopyRules,
  refused: ReadonlySet<string> = new Set(),
): Copies {
  const copies: MemoryEntry[] = [];
  const copied = new Set<string>();
  const twins = new Set<string>();
  for (const key of candidates) {
    const entry = byId.get(key.id);
    // A row the global store dropped or edited between the two reads waits for the next sync.
    if (!entry || entry.content !== key.content) continue;
    if (copied.has(textKey(entry))) {
      twins.add(textKey(entry));
      continue;
    }
    if (detectSecret(entry).flagged) continue;
    if (
      rules.includeCrossProject !== true &&
      classifyOriginProject(entry.originProject, rules.project) === 'cross-project'
    ) {
      continue;
    }
    copies.push(entry);
    // A refused text is no copy, so its twin is tried too and leaves its own refusal row.
    if (!refused.has(textKey(entry))) copied.add(textKey(entry));
  }
  return { copies, twins };
}

/** The texts held twice whose first copy a rejection refuses. */
async function refusedTexts(store: SharingStore, { copies, twins }: Copies): Promise<Set<string>> {
  const firsts = copies.filter((e) => twins.has(textKey(e)));
  const refused = await store.rejections.refusedAmong(
    firsts.map((e) => ({ tenantId: e.tenantId, entryId: e.id, content: e.content })),
  );
  return new Set(firsts.filter((_, i) => refused[i]).map(textKey));
}

/** One transaction: id, tenant and text decide which rows to read whole, and the copies commit together; each copy
 * keeps its own tenant. */
async function copyMissingRows(into: ConfiguredFolder<SharingStore>, from: SharingStore, rules: CopyRules) {
  const candidates = await missingRows(into.store.sharing, from.sharing);
  if (candidates.length === 0) return 0;
  const byId = new Map<string, MemoryEntry>();
  for (const ids of chunked(candidates.map((k) => k.id))) {
    for (const entry of await from.sharing.entriesByIds(ids)) byId.set(entry.id, entry);
  }

  // Syncing down must not re-import what ambient context excludes: other-project rows are skipped by default and secret
  // rows never copied. origin_project is preserved on the copy (the write stamps it only when missing).
  const first = copiesOf(candidates, byId, rules);
  const { copies } =
    first.twins.size === 0 ? first : copiesOf(candidates, byId, rules, await refusedTexts(into.store, first));
  // A locally rejected value must not come back through sync down: skipped per item, printed as one line.
  const written = copies.length === 0 ? [] : await into.store.lessonWrites.writeSkippingRejected(copies, CLI_ACTOR);
  finishSyncDown(into, written.length, copies.length - written.length);
  return written.length;
}

function finishSyncDown(into: ConfiguredFolder, count: number, rejected: number): void {
  if (rejected > 0) {
    log.warn(
      `syncGlobalToLocal: skipped ${rejected} rejected value(s) (run \`hippo unreject\` on the local store to allow).`,
    );
  }

  // Batch producer: one embedAll() on the destination rather than an embedMemory() per copied row (same batching
  // invariant as autoShare).
  if (count > 0) {
    void embedAll(folderIndex(into)).catch((err) => logEmbedAllFailure('syncGlobalToLocal', err));
  }
}
