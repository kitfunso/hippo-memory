import { BadRequestError } from '../../base/errors/api-errors.js';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../../base/memory/agent-memory-tools.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { identityText } from '../../base/util/same-text.js';
import { classifyOriginProject, type ProjectIdentity } from '../../base/scope/project-identity.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { embedAll, folderEmbedTarget, type EmbedRun } from '../search/embed-memories.js';
import type { DetachedWork } from '../search/detached-work.js';
import type { ConfiguredFolder } from '../../base/config/configured-folder.js';
import { log } from '../../base/util/log.js';
import type { EntryTextKey, Sharing } from '../../base/ports/store.js';
import { logEmbedAllFailure } from './search-both.js';
import { textKeyPages, type SharingStore } from './text-keys.js';

/**
 * Copy all global memories into the local store, skipping entries that already exist locally by
 * ID or text (promote and share copy under a new ID). Stores built on the caller's session open
 * each store once. Returns the count of newly copied entries. */
export async function syncGlobalToLocal(
  into: ConfiguredFolder<SharingStore>,
  global: { readonly store: SharingStore },
  opts: { includeCrossProject?: boolean } & SyncEmbed,
): Promise<number> {
  const home = await into.store.folderFiles.home();
  if (home.shared) {
    throw new BadRequestError(
      `Refusing to sync into ${home.folder}: a shared store takes no copies of a personal global store, ` +
        `whose rows would reach every member.`,
    );
  }
  if (!(await global.store.folderFiles.home()).exists) return 0;

  const rules = { project: home.project, includeCrossProject: opts.includeCrossProject };
  return copyMissingRows(into, global.store, rules, opts);
}

interface SyncEmbed {
  readonly embed: EmbedRun;
  readonly detached: DetachedWork;
}

const textKey = (e: { tenantId: string; content: string; leadIn?: string | null }): string =>
  `${e.tenantId}\n${identityText(e)}`;

/** Global rows of every tenant that the local store holds by neither id nor tenant and text,
 * oldest first; each page asks the local store about its own ids and texts only. */
async function missingRows(local: Sharing, from: Sharing): Promise<EntryTextKey[]> {
  const missing: EntryTextKey[] = [];
  for await (const page of textKeyPages(from, ALL_TENANTS)) {
    const taken = new Set(await local.takenIds(page.map((k) => k.id)));
    const open = page.filter(
      (k) => !taken.has(k.id) && !k.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX),
    );
    if (open.length === 0) continue;
    const held = await local.textKeysHolding({ tenantId: ALL_TENANTS }, open.map(identityText));
    const heldKeys = new Set(held.map(textKey));
    missing.push(...open.filter((k) => !heldKeys.has(textKey(k))));
  }
  return missing;
}

interface CopyRules {
  readonly project: ProjectIdentity;
  readonly includeCrossProject?: boolean;
}

interface Copies {
  readonly copies: MemoryEntry[];
  readonly twins: Set<string>;
}

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
    if (
      !entry ||
      entry.content !== key.content ||
      (entry.leadIn || null) !== (key.leadIn || null)
    ) {
      continue;
    }
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
    if (!refused.has(textKey(entry))) copied.add(textKey(entry));
  }
  return { copies, twins };
}

async function refusedTexts(store: SharingStore, { copies, twins }: Copies): Promise<Set<string>> {
  const firsts = copies.filter((e) => twins.has(textKey(e)));
  const refused = await store.rejections.refusedAmong(
    firsts.map((e) => ({
      tenantId: e.tenantId,
      entryId: e.id,
      content: e.content,
      leadIn: e.leadIn,
    })),
  );
  return new Set(firsts.filter((_, i) => refused[i]).map(textKey));
}

async function copyMissingRows(
  into: ConfiguredFolder<SharingStore>,
  from: SharingStore,
  rules: CopyRules,
  embedding: SyncEmbed,
) {
  const candidates = await missingRows(into.store.sharing, from.sharing);
  if (candidates.length === 0) return 0;
  const byId = new Map<string, MemoryEntry>();
  const wanted = candidates.map((k) => k.id);
  for (const entry of await from.entriesByIds(wanted, ALL_TENANTS)) byId.set(entry.id, entry);

  const first = copiesOf(candidates, byId, rules);
  const { copies } =
    first.twins.size === 0
      ? first
      : copiesOf(candidates, byId, rules, await refusedTexts(into.store, first));
  const written =
    copies.length === 0
      ? []
      : await into.store.lessonWrites.writeSkippingRejected(copies, CLI_ACTOR);
  finishSyncDown(into, written.length, copies.length - written.length, embedding);
  return written.length;
}

function finishSyncDown(
  into: ConfiguredFolder<SharingStore>,
  count: number,
  rejected: number,
  { embed, detached }: SyncEmbed,
): void {
  if (rejected > 0) {
    log.warn(
      `syncGlobalToLocal: skipped ${rejected} rejected value(s) (run \`hippo unreject\` on the local store to allow).`,
    );
  }

  if (count > 0) {
    detached.detach(
      embedAll(folderEmbedTarget(into, embed)).catch((err) =>
        logEmbedAllFailure('syncGlobalToLocal', err),
      ),
    );
  }
}
