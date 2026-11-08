// Over one store, every reader answers "is this memory live?" from the same rule: entriesWhere, the context
// read, recall search, the dashboard and isLiveMemory.
import { beforeAll, describe, expect, it } from 'vitest';
import { supersede } from '../../src/api/index.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { isLiveMemory } from '../../src/base/memory/liveness.js';
import { quarantineScopeFor } from '../../src/base/scope/recall-scope.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { DashboardPageQuery, DashboardTotals } from '../../src/base/ports/store/dashboard-reads.js';
import { sqliteDashboardReads } from '../../src/store/sqlite/reports/dashboard-reads.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadContextCandidates, loadRecallEntries, readEntry, writeEntry } from '../_helpers/root-forms.js';

const TENANT = 'default';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const PROJECT = 'alpha';

const READERS = ['entries', 'context', 'recall', 'dashboard', 'liveness'] as const;
type Reader = (typeof READERS)[number];

const ROWS = ['live', 'superseded', 'successor', 'quarantined', 'raw', 'kindSuperseded', 'blank'] as const;
type Row = (typeof ROWS)[number];

// entriesWhere({ live }) tests the link alone, so it keeps a quarantined row the scope-aware readers drop. A kind
// 'superseded' row is left open for all but the dashboard and isLiveMemory: recall search keeps it today.
const EXPECTED = {
  live: { entries: true, context: true, recall: true, dashboard: true, liveness: true },
  superseded: { entries: false, context: false, recall: false, dashboard: false, liveness: false },
  successor: { entries: true, context: true, recall: true, dashboard: true, liveness: true },
  quarantined: { entries: true, context: false, recall: false, dashboard: false, liveness: false },
  raw: { entries: true, context: true, recall: true, dashboard: true, liveness: true },
  kindSuperseded: { dashboard: false, liveness: false },
  blank: { entries: false, context: false, recall: false, dashboard: false, liveness: false },
} satisfies Record<Row, Partial<Record<Reader, boolean>>>;
const wantedOf = (name: Row): Partial<Record<Reader, boolean>> => EXPECTED[name];

const EVERY_ROW: DashboardPageQuery = {
  origin: PROJECT,
  layers: [0, 1, 2, 3],
  minAgeDays: -Infinity,
  maxAgeDays: Infinity,
  minStrength: -Infinity,
  maxStrength: Infinity,
  text: null,
  sort: 'content',
  descending: false,
  chip: 'all',
  offset: 0,
  limit: 100,
};

function row(content: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(`beacon ${content}`, { tenantId: TENANT }), originProject: PROJECT, ...over };
}

/** Writes one memory per row name through the store's writers, supersedes one through the api, and sets one blank link
 * by raw SQL since no writer makes it. Returns each name's id. */
async function seed(root: string): Promise<Record<Row, string>> {
  const live = row('current note');
  const old = row('replaced note');
  const quarantined = row('held note', { scope: quarantineScopeFor('team:alpha') });
  const raw = row('raw receipt', { kind: 'raw', sourceSessionId: 's1' });
  const kindSuperseded = row('kind marked note', { kind: 'superseded' });
  const blank = row('blank linked note');
  for (const entry of [live, old, quarantined, raw, kindSuperseded, blank]) writeEntry(root, entry);
  const { newId } = await supersede(apiCtx(root, TENANT), old.id, 'beacon successor note');
  const db = openHippoDb(root);
  try {
    db.prepare(`UPDATE memories SET superseded_by = '' WHERE id = ?`).run(blank.id);
  } finally {
    closeHippoDb(db);
  }
  return {
    live: live.id,
    superseded: old.id,
    successor: newId,
    quarantined: quarantined.id,
    raw: raw.id,
    kindSuperseded: kindSuperseded.id,
    blank: blank.id,
  };
}

interface Answers {
  readonly members: Readonly<Record<Reader, ReadonlySet<string>>>;
  readonly totals: DashboardTotals;
}

async function dashboardRead(root: string): Promise<{ ids: string[]; totals: DashboardTotals }> {
  const reads = sqliteDashboardReads(root);
  try {
    const page = await reads.memoryPage(TENANT, EVERY_ROW, NOW);
    return { ids: (page?.rows ?? []).map((r) => r.id), totals: await reads.totals(TENANT, NOW) };
  } finally {
    await reads.close();
  }
}

/** The ids each reader returns over the seeded store; recall drops superseded rows as the retrieve path does. */
async function ask(root: string, ids: Record<Row, string>): Promise<Answers> {
  const entries = await apiCtx(root, TENANT).store.entriesWhere({ tenantId: TENANT, live: true }, { limit: 100 });
  const context = loadContextCandidates(root, TENANT, { cap: 100, now: new Date(NOW) });
  const recall = loadRecallEntries(root, 'beacon', { tenantId: TENANT, includeSuperseded: false });
  const dashboard = await dashboardRead(root);
  const liveByRule = ROWS.map((name) => ids[name]).filter((id) => {
    const entry = readEntry(root, id, TENANT);
    return entry !== null && isLiveMemory(entry);
  });
  return {
    members: {
      entries: new Set(entries.entries.map((e) => e.id)),
      context: new Set(context.map((e) => e.id)),
      recall: new Set(recall.map((e) => e.id)),
      dashboard: new Set(dashboard.ids),
      liveness: new Set(liveByRule),
    },
    totals: dashboard.totals,
  };
}

describe('liveness agreement across readers', () => {
  let root: string;
  let ids: Record<Row, string>;
  let answers: Answers;

  beforeAll(async () => {
    root = makeRoot('liveness-agreement');
    ids = await seed(root);
    answers = await ask(root, ids);
  });

  it.each(ROWS)('answers for the %s row as the contract says', (name) => {
    for (const reader of READERS) {
      const wanted = wantedOf(name)[reader];
      if (wanted !== undefined) expect(answers.members[reader].has(ids[name]), `${name} in ${reader}`).toBe(wanted);
    }
  });

  it('tallies the dashboard live rows and counts each row left out once', () => {
    const live = ROWS.filter((name) => wantedOf(name).dashboard);
    expect(answers.totals.projects.map((p) => [p.origin, p.live])).toEqual([[PROJECT, live.length]]);
    // Superseded: the linked row, the blank-linked row and the kind 'superseded' row.
    expect(answers.totals.excluded).toEqual({ superseded: 3, archived: 0, quarantined: 1 });
  });

  it('refuses to supersede the blank-linked row without naming an empty successor', async () => {
    await expect(supersede(apiCtx(root, TENANT), ids.blank, 'beacon late note')).rejects.toThrow(
      `Memory ${ids.blank} is already superseded.`,
    );
  });
});
