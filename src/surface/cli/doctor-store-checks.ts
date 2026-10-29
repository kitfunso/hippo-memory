// The `hippo doctor` checks that read the database and the compaction spool.

import * as path from 'node:path';
import type { StoreHealth } from '../../base/ports/store/diagnostics.js';
import { needsNewerHippo } from '../../base/errors/store-open.js';
import {
  REPLAY_AFTER_MS,
  TRANSCRIPT_FILL_WINDOW_MS,
} from '../../base/session/compaction-timing.js';
import { SPOOL_DIR, type SpoolFs } from '../../infra/spool-files.js';
import { spoolCounts, type SpoolCounts } from '../../infra/spool-counts.js';
import { globalProjectRepairPlan } from '../../api/objects/projects.js';
import { currentMachine } from '../../infra/machine.js';
import { errorMessage, log } from '../../base/util/log.js';
import { DAY_MS } from '../../base/util/time.js';
import { plural } from '../../base/util/format.js';
import type { DoctorCheck, DoctorStore } from './doctor.js';

// The migration that creates failure_log; a read-only open no longer creates it on an older store.
const FAILURE_LOG_SCHEMA = 46;

/** The failed-tool-call count over the last 7 days, or why it could not be read. */
function failuresCheck(failures: StoreHealth['failures'], schemaVersion: number): DoctorCheck {
  if (failures.ok) {
    return {
      id: 'failures',
      status: 'info',
      detail: `${failures.value} failed tool calls logged in 7 days (hippo failures for detail)`,
    };
  }
  if (!failures.message.includes('no such table')) {
    return {
      id: 'failures',
      status: 'warn',
      detail: `cannot read the failure log: ${failures.message}`,
    };
  }
  return schemaVersion < FAILURE_LOG_SCHEMA
    ? {
        id: 'failures',
        status: 'info',
        detail: 'no failure log yet (hippo creates it on the next write)',
      }
    : {
        id: 'failures',
        status: 'warn',
        detail: 'the failure_log table is missing, so failed tool calls are not being logged',
      };
}

/** How long ago the store last slept (consolidated), or why that history could not be read. */
function sleepCheck(lastSleep: StoreHealth['lastSleep'], now: Date): DoctorCheck {
  if (!lastSleep.ok) {
    return {
      id: 'sleep',
      status: 'info',
      detail: `sleep history unavailable (${lastSleep.message})`,
    };
  }
  const last = lastSleep.value;
  const when = last !== undefined ? Date.parse(last) : Number.NaN;
  if (Number.isNaN(when)) {
    return {
      id: 'sleep',
      status: 'warn',
      detail: 'hippo has never slept (consolidated) in this store',
      fix: 'hippo sleep   (the session-end hook runs it automatically)',
    };
  }
  const days = Math.floor((now.getTime() - when) / DAY_MS);
  return days > 7
    ? {
        id: 'sleep',
        status: 'warn',
        detail: `last sleep ${days} days ago`,
        fix: 'hippo sleep, and check the session-end hook is installed',
      }
    : {
        id: 'sleep',
        status: 'pass',
        detail: `last sleep ${days === 0 ? 'today' : `${plural(days, 'day')} ago`}`,
      };
}

interface SpoolRead {
  counts: SpoolCounts;
  /** The detail's `; spool not read: <msg>` tail, empty when the spool was read. */
  unread: string;
}

/** Spool counts in their own try, so a spool that cannot be read never hides the database
 * counts. */
function readSpool(store: string, now: Date, spoolFs?: SpoolFs): SpoolRead {
  try {
    return { counts: spoolCounts(store, now, REPLAY_AFTER_MS, spoolFs), unread: '' };
  } catch (err) {
    return {
      counts: { waiting: 0, stale: 0, bad: 0 },
      unread: `; spool not read: ${errorMessage(err)}`,
    };
  }
}

/**
 * Compaction records the PostCompact hook left unfinished and spool files a replay has not
 * finished, which `hippo sleep` replays.
 */
function compactionsCheck(
  compactions: StoreHealth['compactions'],
  store: string,
  now: Date,
  spoolFs?: SpoolFs,
): DoctorCheck {
  if (!compactions.ok) return unreadCompactionsCheck(compactions.message);
  const { total, summarised, started } = compactions.value;
  const stuck = summarised + started;
  const { counts: spool, unread } = readSpool(store, now, spoolFs);
  const spooled = spool.waiting + spool.stale + spool.bad > 0;
  const recorded = `${plural(total, 'compaction')} recorded, none stuck`;
  if (stuck === 0 && !spooled && unread === '') {
    return { id: 'compactions', status: 'pass', detail: recorded };
  }
  const fix = compactionsFix(stuck, spool, store);
  const unfinished =
    stuck === 0
      ? `${recorded} in the store`
      : `${plural(stuck, 'compaction')} unfinished after 10 minutes ` +
        `(${summarised} with a summary whose memories are not saved yet, ${started} with no summary yet)`;
  const note = spooled
    ? `; spool: ${spool.waiting} waiting, ${spool.stale} left by a replay that stopped, ${spool.bad} .bad`
    : '';
  return {
    id: 'compactions',
    status: 'warn',
    detail: `${unfinished}${note}${unread}`,
    fix: fix.join('; '),
  };
}

function unreadCompactionsCheck(message: string): DoctorCheck {
  return message.includes('no such table')
    ? {
        id: 'compactions',
        status: 'info',
        detail: 'no compaction records yet (hippo creates them on the next write)',
      }
    : {
        id: 'compactions',
        status: 'warn',
        detail: `cannot read the compaction records: ${message}`,
      };
}

function compactionsFix(stuck: number, spool: SpoolCounts, store: string): string[] {
  return [
    stuck + spool.waiting + spool.stale > 0 ? 'hippo sleep   (replays them)' : '',
    spool.bad > 0
      ? `open the .bad files in ${path.join(store, SPOOL_DIR)}, save what you still need with hippo remember, then ` +
        `delete them`
      : '',
  ].filter((s) => s !== '');
}

/** Old project tags in the global store, counted by the repair's own plan so a truly user-global
 * merge never warns. */
export async function projectsCheck(global: DoctorStore, tenantId: string): Promise<DoctorCheck> {
  try {
    const r = await globalProjectRepairPlan(global, tenantId, currentMachine());
    const found = [
      r.copies.length > 0 ? `${r.copies.length} imported notes copied under the wrong project` : '',
      r.folds.length > 0
        ? `old project names that now resolve to another project: ` +
          `${r.folds.map((f) => `${f.from} -> ${f.into}`).join(', ')}`
        : '',
      r.collisions.length > 0
        ? `old project names shared by several projects, folded by hand only: ` +
          `${r.collisions.map((c) => `${c.name} (${c.ids.join(', ')})`).join('; ')}`
        : '',
      r.toProject.length + r.setAside.length > 0
        ? `${r.toProject.length + r.setAside.length} merged memories tagged user-global`
        : '',
    ].filter((s) => s !== '');
    return found.length === 0
      ? {
          id: 'projects',
          status: 'pass',
          detail: 'no duplicate or out-of-date project tags in the global store',
        }
      : {
          id: 'projects',
          status: 'warn',
          detail: `global store: ${found.join('; ')}`,
          fix: 'hippo projects repair --global   (dry run; add --apply to write)',
        };
  } catch (err) {
    return {
      id: 'projects',
      status: 'info',
      detail: `project tags not checked (${errorMessage(err)})`,
    };
  }
}

function schemaCheck(have: number, want: number): DoctorCheck {
  return have === want
    ? { id: 'schema', status: 'pass', detail: `database schema v${have}` }
    : have > want
      ? {
          id: 'schema',
          status: 'fail',
          detail: `database schema v${have} is newer than this hippo (v${want})`,
          fix: 'npm install -g hippo-memory@latest',
        }
      : {
          id: 'schema',
          status: 'info',
          detail: `database schema v${have}; hippo migrates it to v${want} on the next write`,
        };
}

function memoriesCheck(memories: number | null, dormant: number | null): DoctorCheck {
  const memoryCheck: DoctorCheck = {
    id: 'memories',
    status: 'info',
    detail: `${memories ?? '?'} memories${dormant !== null ? `, ${dormant} dormant` : ''}`,
  };
  if (memories === 0) {
    memoryCheck.status = 'warn';
    memoryCheck.fix = 'hippo learn --git   (seed lessons from git history)';
  }
  return memoryCheck;
}

/**
 * Whether the full-text index still matches `memories`; opening a current store no longer checks,
 * so doctor reports and sleep repairs.
 */
function ftsCheck(fts: StoreHealth['fts']): DoctorCheck {
  if (!fts.ok) {
    return { id: 'fts', status: 'warn', detail: `cannot read the full-text index: ${fts.message}` };
  }
  const counts = fts.value;
  if (counts === null) {
    return {
      id: 'fts',
      status: 'info',
      detail: 'no full-text index; search uses slower LIKE matching',
    };
  }
  if (counts.memories === counts.fts) {
    return { id: 'fts', status: 'pass', detail: `full-text index in sync (${counts.fts} rows)` };
  }
  return {
    id: 'fts',
    status: 'warn',
    detail:
      `full-text index out of sync: ${counts.fts} indexed rows for ${counts.memories} memories, so search can ` +
      `miss memories or match removed ones`,
    fix: 'hippo sleep   (re-syncs the index)',
  };
}

function tokensCheck(tokens: StoreHealth['tokens']): DoctorCheck {
  if (!tokens.ok) {
    log.debug(`doctor: token ledger not read: ${tokens.message}`);
    return {
      id: 'tokens',
      status: 'info',
      detail: 'no token ledger yet (created on the next write)',
    };
  }
  const tally = tokens.value;
  return {
    id: 'tokens',
    status: 'info',
    detail:
      `${tally.injected} memory blocks sent to agents in 7 days, about ${tally.tokensSent} tokens sent ` +
      `and ${tally.tokensReread} re-read by later model calls (hippo tokens for detail)`,
  };
}

/** Checks that read the store's database; a store that cannot be opened becomes one failed
 * schema check. */
export async function databaseChecks(
  { diagnostics }: DoctorStore,
  store: string,
  now: Date,
  spoolFs?: SpoolFs,
): Promise<DoctorCheck[]> {
  let health: StoreHealth;
  try {
    health = await diagnostics.health({
      since: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
      stuckBefore: new Date(now.getTime() - REPLAY_AFTER_MS).toISOString(),
      transcriptFloor: new Date(now.getTime() - TRANSCRIPT_FILL_WINDOW_MS).toISOString(),
    });
  } catch (err) {
    return [
      {
        id: 'schema',
        status: 'fail',
        detail: `cannot open the database: ${errorMessage(err)}`,
        fix: needsNewerHippo(err)
          ? 'npm install -g hippo-memory@latest'
          : 'check file permissions on the .hippo folder',
      },
    ];
  }
  return [
    schemaCheck(health.schemaVersion, health.binarySchemaVersion),
    memoriesCheck(health.memories, health.dormant),
    ftsCheck(health.fts),
    tokensCheck(health.tokens),
    failuresCheck(health.failures, health.schemaVersion),
    sleepCheck(health.lastSleep, now),
    compactionsCheck(health.compactions, store, now, spoolFs),
  ];
}
