// The reads of the port groups that were hippo.db's local files, as the reader-thread parity test runs them, and the rows they need.
import { inspect } from 'node:util';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import type { HippoDbStore } from '../../src/store/sqlite/hippo-db.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant/dormant-rows.js';
import { startCompaction } from '../../src/store/sqlite/capture/compactions-record.js';
import { sqliteStore } from './test-session.js';
import { createMemory } from './default-half-life-memory.js';
import type { MovedReadsSeed } from './moved-reads-seed.js';
import { TENANT } from './recall-golden-seed.js';
import { markGraphDirty, writeEntry } from './root-forms.js';
import { onDb } from './store-worker-server.js';

export type Call<T> = (store: HippoDbStore, seed: MovedReadsSeed) => Promise<T>;

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
  // The two texts differ only by spacing, which is what the dedupe partitions on.
  const twins = [
    live('mem_z_twin1', 'the release train leaves at noon on thursday'),
    live('mem_z_twin2', 'the release  train leaves at noon on thursday'),
  ];
  for (const row of [note, ...twins]) writeEntry(root, row);
  // A pending queue row, for the read of the tenants with graph work waiting.
  markGraphDirty(root, TENANT, 'mem_p_plain');
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
  // Folds the compaction records' stale project name into the seeded one, which leaves the merge's audit row.
  await s.projectTags.merge(
    { tenantId: TENANT, actor: ACTOR },
    { from: 'stale-project', into: PROJECT, dryRun: false },
  );
  await s.projectTags.markRepairedOnce();
  await s.close();
}

const CUTOFFS = { since: EVER, stuckBefore: NEVER, transcriptFloor: EVER };

export const LOCAL_GROUP_READS: readonly Read[] = [
  read('captures.textsHolding', (s) => s.captures.textsHolding(TENANT, [PLAIN], {}), PLAIN),
  read('compactionHooks.openRecords', (s) => s.compactionHooks.openRecords(TENANT, {}), TRANSCRIPT),
  read(
    'hippoDb.consolidation.entryIdsPage',
    (s) => s.hippoDb.consolidation.entryIdsPage({ limit: 3 }),
    /ids: \[ 'mem_/,
  ),
  read(
    'hippoDb.consolidation.rejected',
    (s) => s.hippoDb.consolidation.rejected(TENANT, [rejectionDigest(REFUSED), rejectionDigest(PLAIN)]),
    "reason: 'wrong'",
  ),
  read(
    'hippoDb.consolidation.duplicateCandidates',
    (s) => s.hippoDb.consolidation.duplicateCandidates(),
    'mem_z_twin2',
  ),
  read(
    'hippoDb.consolidation.dirtyGraphTenants',
    (s) => s.hippoDb.consolidation.dirtyGraphTenants(),
    /maxPendingId: [1-9]/,
  ),
  read('hippoDb.consolidation.dirtySummaries', (s) => s.hippoDb.consolidation.dirtySummaries(10), 'mem_x_child1'),
  read(
    'hippoDb.consolidation.unprofiledTopicSummaries',
    (s) => s.hippoDb.consolidation.unprofiledTopicSummaries({ limit: 10 }),
    'mem_x_summary',
  ),
  read('diagnostics.health', (s) => s.diagnostics.health(CUTOFFS), /started: 2/),
  read('diagnostics.inventory', (s) => s.diagnostics.inventory(), /compactions: 2/),
  read(
    'hippoDb.learning.entriesMentioning',
    (s) => s.hippoDb.learning.entriesMentioning(['deploy'], 'goal-alpha', TENANT, { limit: 50 }),
    'mem_p_plain',
  ),
  read(
    'hippoDb.learning.readEntry',
    (s) => s.hippoDb.learning.readEntry(NOTE, TENANT),
    'the rollout runbook lives in the team wiki',
  ),
  read(
    'projectTags.originTallies',
    (s) => s.projectTags.originTallies(TENANT, IMPORTED),
    /origin: 'seeded-project', prefixed: 1/,
  ),
  read(
    'projectTags.dormantWhere',
    async (s) => [
      await s.projectTags.dormantWhere({ tenantId: TENANT, sourcePrefix: IMPORTED }),
      await s.projectTags.dormantWhere({ tenantId: TENANT, origins: [PROJECT] }),
      await s.projectTags.dormantWhere({ tenantId: TENANT, ids: ['mem_d_agent', 'mem_missing'] }),
    ],
    /mem_d_agent[\s\S]*mem_d_agent[\s\S]*mem_d_agent/,
  ),
  read(
    'projectTags.compactionOrigins',
    (s) => s.projectTags.compactionOrigins(TENANT),
    `cwd: '${CWD}', origin: '${PROJECT}', transcript: '${TRANSCRIPT}'`,
  ),
  read('projectTags.repairedOnce', (s) => s.projectTags.repairedOnce(), /^true$/),
  read(
    'hippoDb.learning.confirmedOutcomeTimes',
    (s) => s.hippoDb.learning.confirmedOutcomeTimes(TENANT, EVER),
    `'${NOTE}' =>`,
  ),
];
