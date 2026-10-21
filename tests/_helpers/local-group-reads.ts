// The reads of the port groups that were hippo.db's local files, as the reader-thread parity test runs them, and the rows they need.
import { inspect } from 'node:util';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import type { HippoStore, StoreGroups } from '../../src/store/index.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { startCompaction } from '../../src/store/sqlite/compactions-record.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from './default-half-life-memory.js';
import type { MovedReadsSeed } from './moved-reads-seed.js';
import { SESSION, TENANT } from './recall-golden-seed.js';
import { appendSessionEvent, markGraphDirty, writeEntry } from './root-forms.js';
import { onDb } from './store-worker-server.js';

export type Served = HippoStore & StoreGroups;
export type Call<T> = (store: Served, seed: MovedReadsSeed) => Promise<T>;

/** A value as text, so a Map, a typed array and an undefined field all take part in the comparison. */
export function shown<T>(value: T): string {
  const text = inspect(value, {
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: Infinity,
    sorted: true,
  });
  // A row from node:sqlite has no prototype and its copy from a thread has Object's; no caller reads the difference.
  return text.replaceAll('[Object: null prototype] ', '');
}

export interface Read {
  readonly name: string;
  readonly run: Call<string>;
  /** In the answer, so a read that found nothing on both stores cannot pass. */
  readonly shows: string | RegExp;
}

export function read<T>(name: string, run: Call<T>, shows: string | RegExp): Read {
  return { name, run: async (store, seed) => shown(await run(store, seed)), shows };
}

export const PLAIN = 'deploy pipeline uses blue green rollout for the api';
export const REFUSED = 'never deploy on a friday afternoon';

const IMPORTED = 'agent-memory:claude:seeded/';
// Ids that sort after the shared seed's, so the reads that page by id keep their first rows.
const NOTE = 'mem_z_note';
const PROJECT = 'seeded-project';
const CWD = 'C:/seeded/project';
const TRACE_SESSION = 'trace-session';
const TRANSCRIPT = 'C:/seeded/transcript.jsonl';
const ACTOR = 'local-group-seed';
const HOUR_MS = 60 * 60 * 1000;
const EVER = '2000-01-01T00:00:00.000Z';
const NEVER = '9999-12-31T23:59:59.999Z';

const live = (id: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { tenantId: TENANT }),
  id,
  ...over,
});

/** The rows these reads need that the shared seed lacks, each written through a store or the helper that makes it. */
export async function seedLocalGroups(root: string): Promise<void> {
  const note = live(NOTE, 'the rollout runbook lives in the team wiki', {
    source: `${IMPORTED}note.md#h1`,
    originProject: PROJECT,
  });
  const trace = {
    ...createMemory('deploy trace: ran the canary and held the release', {
      tenantId: TENANT,
      layer: Layer.Trace,
      traceOutcome: 'success',
      sourceSessionId: TRACE_SESSION,
    }),
    id: 'mem_z_trace',
  };
  // The two texts differ only by spacing, which is what the dedupe partitions on.
  const twins = [
    live('mem_z_twin1', 'the release train leaves at noon on thursday'),
    live('mem_z_twin2', 'the release  train leaves at noon on thursday'),
  ];
  for (const row of [note, trace, ...twins]) writeEntry(root, row);
  // A pending queue row, for the read of the tenants with graph work waiting.
  markGraphDirty(root, TENANT, 'mem_p_plain');
  appendSessionEvent(root, TENANT, {
    sessionId: TRACE_SESSION,
    eventType: 'session_complete',
    content: 'wrapped up',
  });
  onDb(root, (db) => {
    const gone = live('mem_d_agent', 'an imported note whose file was deleted', {
      source: `${IMPORTED}old.md#h2`,
      originProject: PROJECT,
    });
    insertDormantRow(db, { entry: gone, strength: 0.01, reason: 'source-deleted', dormantAt: EVER });
    // Started long enough ago to be past the replay window, the later one ending the earlier one's transcript window.
    const start = { sessionId: 'compact-session', originProject: 'stale-project', trigger: 'auto', cwd: CWD };
    startCompaction(db, TENANT, { ...start, transcriptPath: TRANSCRIPT }, new Date(Date.now() - 3 * HOUR_MS));
    startCompaction(db, TENANT, { ...start, transcriptPath: TRANSCRIPT }, new Date(Date.now() - 2 * HOUR_MS));
  });
  const s = sqliteStore(root);
  await s.entryWrites.applyOutcome({ tenantId: TENANT, actor: ACTOR, ownScope: null, ids: [NOTE], good: true });
  for (const timestamp of ['2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z']) {
    await s.consolidation.recordRun({ timestamp, decayed: 0, merged: 0, removed: 0 });
    await s.consolidation.countSleep();
  }
  // Folds the compaction records' stale project name into the seeded one, which leaves the merge's audit row.
  await s.projectTags.merge(
    { tenantId: TENANT, actor: ACTOR },
    { from: 'stale-project', into: PROJECT, dryRun: false },
  );
  await s.projectTags.markRepairedOnce();
  await s.close();
}

const CUTOFFS = { since: EVER, stuckBefore: NEVER, transcriptFloor: EVER };
const idsOfPage = async (s: Served) => (await s.consolidation.entryIdsPage({ limit: 200 })).ids;

export const LOCAL_GROUP_READS: readonly Read[] = [
  read('agentImport.liveBySourcePrefix', (s) => s.agentImport.liveBySourcePrefix(TENANT, IMPORTED), NOTE),
  read(
    'agentImport.dormantBySourcePrefix',
    (s) => s.agentImport.dormantBySourcePrefix(TENANT, IMPORTED),
    'mem_d_agent',
  ),
  read(
    'agentImport.rowsHoldingOutsideSourcePrefix',
    (s) => s.agentImport.rowsHoldingOutsideSourcePrefix(TENANT, [PLAIN], IMPORTED, null),
    'mem_p_plain',
  ),
  read('captures.textsHolding', (s) => s.captures.textsHolding(TENANT, ['deploy'], {}), PLAIN),
  read('compactionHooks.openRecords', (s) => s.compactionHooks.openRecords(TENANT, {}), TRANSCRIPT),
  read('consolidation.entryIdsPage', (s) => s.consolidation.entryIdsPage({ limit: 3 }), /ids: \[ 'mem_/),
  read('consolidation.entriesByIds', (s) => s.consolidation.entriesByIds(['mem_p_plain', 'mem_missing']), PLAIN),
  read('consolidation.objectBackedAmong', async (s) => s.consolidation.objectBackedAmong(await idsOfPage(s)), /'sem_/),
  read('consolidation.sessionDecayContext', (s) => s.consolidation.sessionDecayContext(), /sleepCount: 2/),
  read(
    'consolidation.rejectedValue',
    (s) => s.consolidation.rejectedValue(TENANT, rejectionDigest(REFUSED)),
    "reason: 'wrong'",
  ),
  read('consolidation.halfLifeBase', (s) => s.consolidation.halfLifeBase(), /^[1-9]\d*(\.\d+)?$/),
  read('consolidation.promotableSessions', (s) => s.consolidation.promotableSessions(TENANT, 0), TRACE_SESSION),
  read('consolidation.traceExists', (s) => s.consolidation.traceExists(TENANT, TRACE_SESSION), /^true$/),
  read(
    'consolidation.sessionEvents',
    (s) => s.consolidation.sessionEvents(TENANT, { session_id: SESSION, limit: 5 }),
    'canary passed',
  ),
  read('consolidation.particleIds', (s) => s.consolidation.particleIds(), 'mem_p_noise'),
  read(
    'consolidation.particlesByIds',
    (s) => s.consolidation.particlesByIds(['mem_p_noise', 'mem_missing']),
    'mem_p_noise',
  ),
  read('consolidation.entriesPage', (s) => s.consolidation.entriesPage({ limit: 3 }), /id: 'mem_/),
  read('consolidation.duplicateCandidates', (s) => s.consolidation.duplicateCandidates(), 'mem_z_twin2'),
  read('consolidation.dirtyGraphTenants', (s) => s.consolidation.dirtyGraphTenants(), /maxPendingId: [1-9]/),
  read('consolidation.dirtySummaries', (s) => s.consolidation.dirtySummaries(10), 'mem_x_summary'),
  read(
    'consolidation.childrenOfSummary',
    (s) => s.consolidation.childrenOfSummary('mem_x_summary', TENANT),
    'mem_x_child1',
  ),
  read(
    'consolidation.childrenOfSummaries',
    (s) => s.consolidation.childrenOfSummaries([{ id: 'mem_x_summary', tenantId: TENANT }]),
    'mem_x_child1',
  ),
  read('consolidation.unprofiledTopicSummaries', (s) => s.consolidation.unprofiledTopicSummaries(), 'mem_x_summary'),
  read('diagnostics.health', (s) => s.diagnostics.health(CUTOFFS), /started: 2/),
  read('diagnostics.inventory', (s) => s.diagnostics.inventory(), /compactions: 2/),
  read(
    'learning.entriesMentioning',
    (s) => s.learning.entriesMentioning(['deploy'], 'goal-alpha', TENANT, { limit: 50 }),
    'mem_p_plain',
  ),
  read('learning.readEntry', (s) => s.learning.readEntry(NOTE, TENANT), 'the rollout runbook lives in the team wiki'),
  read(
    'learning.currentEntriesFromOrigins',
    (s) => s.learning.currentEntriesFromOrigins(TENANT, ['seeded-project']),
    NOTE,
  ),
  read(
    'projectTags.originTallies',
    (s) => s.projectTags.originTallies(TENANT, IMPORTED),
    /origin: 'seeded-project', prefixed: 1/,
  ),
  read(
    'projectTags.entriesFromOrigin',
    (s) => s.projectTags.entriesFromOrigin(TENANT, { origin: PROJECT, live: true }, { limit: 10 }),
    NOTE,
  ),
  read(
    'projectTags.liveEntriesBySourcePrefix',
    (s) => s.projectTags.liveEntriesBySourcePrefix(TENANT, IMPORTED, { limit: 10 }),
    NOTE,
  ),
  read('projectTags.entriesByIds', (s) => s.projectTags.entriesByIds(TENANT, [NOTE, 'mem_missing']), NOTE),
  read('projectTags.dormantFromOrigin', (s) => s.projectTags.dormantFromOrigin(TENANT, PROJECT), 'mem_d_agent'),
  read(
    'projectTags.dormantByIds',
    (s) => s.projectTags.dormantByIds(TENANT, ['mem_d_agent', 'mem_missing']),
    'mem_d_agent',
  ),
  read('projectTags.auditEvents', (s) => s.projectTags.auditEvents(TENANT, 'project_merge'), "op: 'project_merge'"),
  read('projectTags.compactionTranscripts', (s) => s.projectTags.compactionTranscripts(TENANT), TRANSCRIPT),
  read('projectTags.compactionOriginsWithCwd', (s) => s.projectTags.compactionOriginsWithCwd(TENANT), CWD),
  read('projectTags.holdsOrigin', (s) => s.projectTags.holdsOrigin(TENANT, 'memories', PROJECT), /^true$/),
  read('projectTags.repairedOnce', (s) => s.projectTags.repairedOnce(), /^true$/),
  read('learning.confirmedOutcomeTimes', (s) => s.learning.confirmedOutcomeTimes(TENANT, EVER), `'${NOTE}' =>`),
];
