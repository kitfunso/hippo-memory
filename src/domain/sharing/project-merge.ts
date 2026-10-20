// `hippo projects`: list the project names a store holds, fold one into another, and repair old tags in one reversible
// pass. The rules here plan from reads; the store applies each plan in one transaction.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transcriptNotesProject } from '../agent-memories/claude-code.js';
import { containerId, containerPrefix } from '../agent-memories/source.js';
import { foldEdges, foldedInto } from '../agent-memories/project-folds.js';
import { AGENT_MEMORY_SOURCE_PREFIX, toolSourcePrefix, toolTag } from '../../base/memory/agent-memory-tools.js';
import { currentMachine } from '../../base/util/agent-homes.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import { projectNames, resolveProjectIdentity, type ProjectIdentity } from '../../base/scope/project-identity.js';
import { duplicateKey } from '../../base/util/same-text.js';
import type { ProjectFold, ProjectTags, ProjectTagScope, RowRetag } from '../../store/port/project-tags.js';
import type { PageRequest } from '../../store/port/sharing.js';
import type { EntryCursor, EntryPage } from '../../store/port/types.js';

export interface ProjectSummary {
  /** '' is user-global, null is unknown; neither can be merged. */
  readonly origin: string | null;
  readonly live: number;
  readonly imported: number;
  readonly newest: string;
  /** Imported notes whose text another project name also holds: a sign of a duplicate import, never a merge target. */
  readonly copiesElsewhere: number;
}

export interface MergeResult {
  readonly from: string;
  readonly into: string;
  /** Imports `into` already holds for the same note, moved to dormant storage; the rest are re-tagged and the next
   * sync files them under `into`. */
  readonly setAside: readonly string[];
  readonly restamped: readonly string[];
  readonly dormantRestamped: readonly string[];
  readonly compactions: number;
  readonly backup: string | null;
}

/** An old name whose session folders now resolve to several projects: no fold can say whose rows are whose. */
export interface ProjectCollision {
  readonly name: string;
  readonly ids: readonly string[];
}

export interface RepairResult {
  /** Imported notes filed under the wrong project, or under a project name when a user-global import holds the same
   * text: set aside. */
  readonly copies: readonly string[];
  /** Names whose recorded session folders all resolve to one other project today, folded as `merge` would. */
  readonly folds: readonly ProjectFold[];
  /** Names left unfolded because their folders now resolve to more than one project; only `merge` by hand can split
   * them. */
  readonly collisions: readonly ProjectCollision[];
  readonly toProject: readonly RowRetag[];
  /** Parents in two projects: the merged text blends them, so it goes dormant and the parents re-merge per project. */
  readonly setAside: readonly string[];
  /** No parent left to say which project, or pinned: left as they are, since hiding them would rest on no evidence. */
  readonly untraced: readonly string[];
  readonly backup: string | null;
}

/** What a plan knows of the store's folder: the global store reads session folders, and a project store folds only its
 * own folder's old name, unless many people share it. */
export type StoreFolder =
  | { readonly isGlobal: true }
  | {
      readonly isGlobal: false;
      readonly shared: boolean;
      readonly project: Pick<ProjectIdentity, 'name' | 'legacyName'>;
    };

/** One tenant's project-tag reads. */
interface Reader {
  readonly tags: ProjectTags;
  readonly tenantId: string;
}

/** Every row of a paged read, one page per call, so no one call holds a whole tenant. */
async function* rowsOf(read: (page: PageRequest) => Promise<EntryPage>): AsyncGenerator<MemoryEntry> {
  let after: EntryCursor | undefined;
  do {
    const page = await read({ limit: READ_PAGE_ROWS, after });
    yield* page.entries;
    after = page.next ?? undefined;
  } while (after !== undefined);
}

function liveRows(r: Reader, prefix: string): AsyncGenerator<MemoryEntry> {
  return rowsOf((page) => r.tags.liveEntriesBySourcePrefix(r.tenantId, prefix, page));
}

/** Per project name, how many of its imports hold a text that another name's import also holds. */
async function copiesByOrigin(imports: AsyncIterable<MemoryEntry>): Promise<Map<string | null, number>> {
  const holders = new Map<string, Map<string | null, number>>();
  for await (const e of imports) {
    const key = duplicateKey(e.content);
    const origin = e.originProject ?? null;
    const byOrigin = holders.get(key) ?? new Map<string | null, number>();
    holders.set(key, byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + 1));
  }
  const copies = new Map<string | null, number>();
  for (const byOrigin of holders.values()) {
    if (byOrigin.size < 2) continue;
    for (const [origin, n] of byOrigin) copies.set(origin, (copies.get(origin) ?? 0) + n);
  }
  return copies;
}

/** Live rows per project name, newest write first, with how many of its imported notes are copies held elsewhere. */
export async function listProjects(tags: ProjectTags, tenantId: string): Promise<ProjectSummary[]> {
  const copies = await copiesByOrigin(liveRows({ tags, tenantId }, AGENT_MEMORY_SOURCE_PREFIX));
  return (await tags.originTallies(tenantId, AGENT_MEMORY_SOURCE_PREFIX))
    .map(({ origin, live, prefixed, newest }) => ({
      origin,
      live,
      imported: prefixed,
      newest,
      copiesElsewhere: copies.get(origin) ?? 0,
    }))
    .sort((a, b) => b.newest.localeCompare(a.newest));
}

/** Refuses user-global and unknown: they are not projects, and folding them would leak or hide every row. */
export function validateMergeNames(from: string, into: string): string | null {
  if (from.trim() === '' || into.trim() === '') {
    return 'both project names are required; user-global and unknown rows cannot be merged';
  }
  if (from === into) return `${from} is already ${into}`;
  return null;
}

/** Folds project `from` into `into` for one tenant in one transaction; a dry run rolls back and writes nothing,
 * mirrors included. */
export async function mergeProjects(
  tags: Pick<ProjectTags, 'merge'>,
  scope: ProjectTagScope,
  opts: { from: string; into: string; dryRun: boolean },
): Promise<MergeResult> {
  const { from, into, dryRun } = opts;
  const refusal = validateMergeNames(from, into);
  if (refusal) throw new Error(refusal);
  return { from, into, ...(await tags.merge(scope, { from, into, dryRun })) };
}

/** Live imports under a project name whose exact text a user-global import holds: a session folder's notes stamped
 * with the folder it ended in. */
async function importCopies(r: Reader): Promise<MemoryEntry[]> {
  const userGlobal = new Set<string>();
  for await (const e of liveRows(r, AGENT_MEMORY_SOURCE_PREFIX)) {
    if (e.originProject === '') userGlobal.add(duplicateKey(e.content));
  }
  const copies: MemoryEntry[] = [];
  for await (const e of liveRows(r, AGENT_MEMORY_SOURCE_PREFIX)) {
    const movable = e.originProject && e.kind !== 'raw' && !e.pinned && toolTag(e.source) !== null;
    if (movable && userGlobal.has(duplicateKey(e.content))) copies.push(e);
  }
  return copies;
}

/** Each Claude session folder a compaction recorded, with the names of each project it resolves to. */
async function sessionOwners(r: Reader): Promise<Map<string, Map<string, string[]>>> {
  const machine = currentMachine();
  const owners = new Map<string, Map<string, string[]>>();
  for (const { transcript, cwd } of await r.tags.compactionTranscripts(r.tenantId)) {
    const project = transcriptNotesProject(transcript, cwd, machine);
    const dir = path.join(path.dirname(transcript), 'memory');
    if (project === null) continue;
    const ids = owners.get(dir) ?? new Map<string, string[]>();
    owners.set(dir, ids.set(project.name, [...new Set([...(ids.get(project.name) ?? []), ...projectNames(project)])]));
  }
  return owners;
}

/** Imports to set aside. The global store also checks each Claude session folder a compaction recorded: its notes under
 * any other project are misfiled, edited or not, and a text copy in the right folder is kept. */
async function strayImports(r: Reader, folder: StoreFolder): Promise<MemoryEntry[]> {
  const copies = await importCopies(r);
  if (!folder.isGlobal) return copies;
  const { platform } = currentMachine();
  const owners = await sessionOwners(r);
  const tool = toolSourcePrefix('claude-code');
  const kept = (e: MemoryEntry): boolean => e.kind !== 'raw' && !e.pinned;
  const origins = new Set<string>();
  for await (const e of liveRows(r, tool)) if (kept(e)) origins.add(e.originProject ?? '');
  const edges = await foldEdges(r.tags, r.tenantId);
  const right = new Set<string>();
  const wrong = new Set<string>();
  for (const [dir, ids] of owners) {
    if (ids.size !== 1) continue;
    // Its names before the id, and names folded into it, are the owner's too: the next sync moves those prefixes under
    // the id.
    const [names] = ids.values();
    const own = new Set([...names, ...foldedInto(edges, names)]);
    for (const origin of new Set([...origins, ...own])) {
      (own.has(origin) ? right : wrong).add(
        containerPrefix('claude-code', containerId(dir, 'project', platform, origin)),
      );
    }
  }
  const prefix = (e: MemoryEntry) => e.source.slice(0, e.source.indexOf('/', tool.length) + 1);
  const misfiled: MemoryEntry[] = [];
  for await (const e of liveRows(r, tool)) if (kept(e) && wrong.has(prefix(e))) misfiled.push(e);
  const seen = new Set(misfiled.map((e) => e.id));
  return [...misfiled, ...copies.filter((e) => !seen.has(e.id) && !right.has(prefix(e)))];
}

/** The global store reads each name's recorded session folders, where a compaction's name came from its cwd; a project
 * store folds only its own folder name. */
async function planFolds(
  r: Reader,
  folder: StoreFolder,
  globalFolds: boolean,
): Promise<Pick<RepairResult, 'folds' | 'collisions'>> {
  // A name someone merged into by hand stays: undoing their choice would rest on the resolver alone.
  const chosen = new Set((await r.tags.auditEvents(r.tenantId, 'project_merge')).map((e) => e.metadata.into));
  if (!folder.isGlobal) {
    return { folds: (await ownLegacyFold(r, folder)).filter((f) => !chosen.has(f.from)), collisions: [] };
  }
  const today = new Map<string, Set<string>>();
  for (const { origin, cwd } of await r.tags.compactionOriginsWithCwd(r.tenantId)) {
    if (fs.existsSync(cwd)) {
      today.set(origin, (today.get(origin) ?? new Set<string>()).add(resolveProjectIdentity(cwd).name));
    }
  }
  const folds: ProjectFold[] = [];
  const collisions: ProjectCollision[] = [];
  for (const [from, names] of today) {
    const [into] = names;
    if (chosen.has(from)) continue;
    if (names.size > 1) collisions.push({ name: from, ids: [...names].sort() });
    else if (into !== '' && into !== from) folds.push({ from, into });
  }
  // A fold into a name that itself folds would land rows by run order; the next repair takes the rest of the chain.
  const sources = new Set(folds.map((f) => f.from));
  return { folds: globalFolds ? folds.filter((f) => !sources.has(f.into)) : [], collisions };
}

/** A project store's rows, dormant snapshots and compaction records written before its id existed carry its folder
 * name. */
async function ownLegacyFold(r: Reader, folder: Extract<StoreFolder, { isGlobal: false }>): Promise<ProjectFold[]> {
  // A shared store's rows carry their callers' names, so one matching its folder's is a member's project, not a legacy
  // tag.
  if (folder.shared) return [];
  const { name, legacyName } = folder.project;
  if (legacyName === '' || legacyName === name) return [];
  const held =
    (await r.tags.holdsOrigin(r.tenantId, 'memories', legacyName)) ||
    (await r.tags.holdsOrigin(r.tenantId, 'compactions', legacyName)) ||
    (await r.tags.dormantFromOrigin(r.tenantId, legacyName)).length > 0;
  return held ? [{ from: legacyName, into: name }] : [];
}

/** A repair plan with its stray imports as read, so the store can skip one that moved before the plan applies. */
interface RepairPlanRows extends Omit<RepairResult, 'copies' | 'backup'> {
  readonly stray: readonly MemoryEntry[];
}

async function planRepair(r: Reader, folder: StoreFolder, globalFolds: boolean): Promise<RepairPlanRows> {
  const { folds, collisions } = await planFolds(r, folder, globalFolds);
  const stray = await strayImports(r, folder);
  return { stray, folds, collisions, ...(await planUserGlobalRepair(r, folds)) };
}

function publicPlan({ stray, ...rest }: RepairPlanRows): Omit<RepairResult, 'backup'> {
  return { copies: stray.map((e) => e.id), ...rest };
}

/** Reads only, so doctor and a dry run take no write lock. */
export async function planProjectRepair(
  tags: ProjectTags,
  tenantId: string,
  folder: StoreFolder,
  globalFolds = true,
): Promise<Omit<RepairResult, 'backup'>> {
  return publicPlan(await planRepair({ tags, tenantId }, folder, globalFolds));
}

/** Parents read with `folds` already applied, so a plan matches what apply does after folding. */
async function planUserGlobalRepair(
  r: Reader,
  folds: readonly ProjectFold[],
): Promise<Pick<RepairResult, 'toProject' | 'setAside' | 'untraced'>> {
  const merges = { origin: '', live: true, sourcePrefix: 'consolidation' } as const;
  const mergeRows = () => rowsOf((page) => r.tags.entriesFromOrigin(r.tenantId, merges, page));
  const origins = await parentOrigins(r, mergeRows(), folds);
  const toProject: RowRetag[] = [];
  const setAside: string[] = [];
  const untraced: string[] = [];
  for await (const row of mergeRows()) {
    if (row.source !== 'consolidation') continue;
    const parents = new Set(row.parents.filter((id) => origins.has(id)).map((id) => origins.get(id) ?? null));
    const [only] = parents;
    if (parents.size === 1 && only === '') continue;
    if (parents.size === 1 && only) toProject.push({ id: row.id, origin: only });
    else if (parents.size > 1 && !row.pinned && row.kind !== 'raw') setAside.push(row.id);
    else untraced.push(row.id);
  }
  return { toProject, setAside, untraced };
}

/** The project of each parent the merges name, live or dormant, with `folds` applied. */
async function parentOrigins(
  r: Reader,
  merges: AsyncIterable<MemoryEntry>,
  folds: readonly ProjectFold[],
): Promise<Map<string, string | null>> {
  const renamed = new Map(folds.map((f) => [f.from, f.into]));
  const after = (origin: string | null | undefined) => (origin ? (renamed.get(origin) ?? origin) : (origin ?? null));
  const parents = new Set<string>();
  for await (const row of merges) for (const id of row.parents) parents.add(id);
  const parentIds = [...parents];
  const live = await r.tags.entriesByIds(r.tenantId, parentIds);
  // A live row outranks a snapshot under its id, so only the parents with no live row are looked up dormant.
  const dormant = await r.tags.dormantByIds(
    r.tenantId,
    parentIds.filter((id) => !live.has(id)),
  );
  const origins = new Map<string, string | null>([...dormant].map(([id, s]) => [id, after(s.entry.originProject)]));
  for (const [id, e] of live) origins.set(id, after(e.originProject));
  return origins;
}

/** The result names only the rows the store changed: one gone or moved since the plan read it was skipped. */
async function applyRepair(
  tags: Pick<ProjectTags, 'repair'>,
  scope: ProjectTagScope,
  plan: RepairPlanRows,
): Promise<RepairResult> {
  const { stray, folds, collisions, untraced } = plan;
  const copies = stray.map((e) => ({ id: e.id, origin: e.originProject ?? null }));
  const planned = { copies, folds, toProject: plan.toProject, setAside: plan.setAside, untraced };
  const done = await tags.repair(scope, planned);
  const { toProject, setAside, backup } = done;
  return { copies: done.copies, folds, collisions, toProject, setAside, untraced, backup };
}

/** Sets aside stray imports, folds the names the resolver now maps elsewhere, then re-tags sleep's user-global merges
 * by their parents; a dry run only plans. */
export async function repairProjects(
  tags: ProjectTags,
  scope: ProjectTagScope,
  folder: StoreFolder,
  opts: { dryRun: boolean },
): Promise<RepairResult> {
  const plan = await planRepair({ tags, tenantId: scope.tenantId }, folder, true);
  return opts.dryRun ? { ...publicPlan(plan), backup: null } : applyRepair(tags, scope, plan);
}

/** True when a repair would change nothing. */
function repairIsEmpty(r: RepairPlanRows): boolean {
  return r.stray.length + r.folds.length + r.toProject.length + r.setAside.length === 0;
}

/** Sleep runs repair once per store, so an upgrade needs no command. Global-store folds stay with `hippo projects
 * repair`: their evidence is compaction folders, blind to a same-named repo that never compacted. */
export async function repairOnceOnSleep(
  tags: ProjectTags,
  scope: ProjectTagScope,
  folder: StoreFolder,
): Promise<RepairResult | null> {
  if (await tags.repairedOnce()) return null;
  const plan = await planRepair({ tags, tenantId: scope.tenantId }, folder, false);
  const result = repairIsEmpty(plan) ? null : await applyRepair(tags, scope, plan);
  await tags.markRepairedOnce();
  return result;
}
