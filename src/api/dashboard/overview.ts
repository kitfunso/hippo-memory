// The overview and one project's detail, built from the store's per-project tallies at the stamp's instant.
import { AT_RISK_BELOW } from '../../base/memory/strength-bands.js';
import { SERIES_DAYS, seriesDay } from '../../base/memory/memory-facts.js';
import { pct, plural, round1 } from '../../base/util/format.js';
import {
  SCATTER_COLS,
  SCATTER_ROWS,
  type DashboardReads,
  type ProjectTally,
  type ScatterRows,
} from '../../store/port/dashboard-reads.js';
import { originOfKey, projectIdentity, round3 } from './live.js';
import type { Stamp } from './snapshot-clock.js';
import type { Kpi, Overview, ProjectDetail, ProjectSummary, ScatterGrid, ScatterPoints } from './types.js';

/** The server words each delta for this range; the client re-slices the series for 7d and 90d. */
const DELTA_DAYS = 30;

/** One project's wire summary, keys in the wire's order. */
function summaryOf(t: ProjectTally): ProjectSummary {
  const [pinned, strong, fading, atRisk] = t.bands;
  const [buffer, episodic, semantic, trace] = t.layers;
  return {
    ...projectIdentity(t.origin),
    live: t.live,
    atRisk,
    share: t.live > 0 ? atRisk / t.live : 0,
    pinned: t.pinned,
    embedded: t.embedded,
    openConflicts: t.openConflicts,
    lastRetrievedDays: t.live > 0 ? round1(t.lastRetrievedDays) : null,
    bands: { pinned, strong, fading, atRisk },
    layers: { buffer, episodic, semantic, trace },
  };
}

const noDays = (): number[] => Array.from({ length: SERIES_DAYS + 1 }, () => 0);

/** 91 daily cumulative points, oldest first, from counts per seriesDay; the oldest day's count is the base. */
function cumulativeSeries(perDay: readonly number[]): number[] {
  let running = perDay[SERIES_DAYS];
  return noDays().map((_, i) => (running += i === 0 ? 0 : perDay[SERIES_DAYS - i]));
}

function addedWithin(series: number[]): number {
  return series[SERIES_DAYS] - series[SERIES_DAYS - DELTA_DAYS];
}

function createdPerDay(tallies: readonly ProjectTally[]): number[] {
  const days = noDays();
  for (const t of tallies) t.createdDays.forEach((n, k) => (days[k] += n));
  return days;
}

/** Named projects by the day each first appeared; one with no created time that parses counts as today. */
function firstSeenPerDay(named: readonly ProjectTally[], nowMs: number): number[] {
  const days = noDays();
  for (const t of named) days[seriesDay(t.firstCreatedMs ?? Number.POSITIVE_INFINITY, nowMs)]++;
  return days;
}

interface Ordered {
  readonly tally: ProjectTally;
  readonly summary: ProjectSummary;
}

/** Named projects by size, then Global, then Unassigned, as the treemap orders them. */
function orderedProjects(tallies: readonly ProjectTally[]): Ordered[] {
  const rank = (p: Ordered): number => (p.summary.kind === 'project' ? 0 : p.summary.kind === 'global' ? 1 : 2);
  return tallies
    .map((tally) => ({ tally, summary: summaryOf(tally) }))
    .sort((a, b) => rank(a) - rank(b) || b.summary.live - a.summary.live || (a.summary.name < b.summary.name ? -1 : 1));
}

function healthKpis(openConflicts: number, coverage: number, total: number, withConflicts: number): Kpi[] {
  const embedded = Math.round(coverage * total);
  return [
    {
      id: 'openConflicts',
      label: 'Open conflicts',
      value: openConflicts,
      series: null,
      delta: `in ${plural(withConflicts, 'project')}`,
    },
    {
      id: 'embeddingCoverage',
      label: 'Embedding coverage',
      value: coverage,
      series: null,
      delta: `${total - embedded} not embedded`,
    },
  ];
}

function topKeys(projects: readonly Ordered[], count: number, score: (p: ProjectSummary) => number): string[] {
  return projects
    .map((p) => p.summary)
    .filter((p) => score(p) > 0)
    .sort((a, b) => score(b) - score(a) || b.live - a.live || (a.key < b.key ? -1 : 1))
    .slice(0, count)
    .map((p) => p.key);
}

function countKpis(ordered: readonly Ordered[], total: number, nowMs: number): Kpi[] {
  const tallies = ordered.map((p) => p.tally);
  const named = ordered.filter((p) => p.summary.kind === 'project');
  const totalSeries = cumulativeSeries(createdPerDay(tallies));
  const projectSeries = cumulativeSeries(
    firstSeenPerDay(
      named.map((p) => p.tally),
      nowMs,
    ),
  );
  const atRisk = ordered.reduce((sum, p) => sum + p.summary.atRisk, 0);
  const weakNow = tallies.reduce((sum, t) => sum + t.weakNow, 0);
  return [
    {
      id: 'total',
      label: 'Total memories',
      value: total,
      series: totalSeries,
      delta: `+${addedWithin(totalSeries)} created in the last ${DELTA_DAYS}d`,
    },
    {
      id: 'projects',
      label: 'Projects',
      value: named.length,
      series: projectSeries,
      delta: `+${addedWithin(projectSeries)} new in ${DELTA_DAYS}d`,
    },
    {
      id: 'atRiskShare',
      label: 'At-risk share, 30d',
      value: total > 0 ? atRisk / total : 0,
      series: null,
      delta: `${pct(total > 0 ? weakNow / total : 0)} now at strength under ${AT_RISK_BELOW}`,
    },
  ];
}

/** The overview of the stamp's tenant at the stamp's instant. */
export async function buildOverview(reads: Pick<DashboardReads, 'totals'>, stamp: Stamp): Promise<Overview> {
  const totals = await reads.totals(stamp.tenantId, stamp.nowMs);
  const ordered = orderedProjects(totals.projects);
  const total = totals.projects.reduce((sum, t) => sum + t.live, 0);
  const coverage = total > 0 ? totals.projects.reduce((sum, t) => sum + t.embedded, 0) / total : 0;
  const withConflicts = ordered.filter((p) => p.summary.openConflicts > 0).length;
  const kpis = [
    ...countKpis(ordered, total, stamp.nowMs),
    ...healthKpis(totals.openConflicts, coverage, total, withConflicts),
  ];
  return {
    snapshotId: stamp.id,
    generatedAt: new Date(stamp.nowMs).toISOString(),
    total,
    excluded: totals.excluded,
    embeddingCoverage: coverage,
    kpis,
    projects: ordered.map((p) => p.summary),
    mostAtRisk: topKeys(ordered, 5, (p) => p.atRisk),
    mostConflicts: topKeys(ordered, 4, (p) => p.openConflicts),
  };
}

function wireScatter(scatter: ScatterRows): ScatterPoints | ScatterGrid {
  if (scatter.mode === 'points') {
    const points = scatter.points.map((p): ScatterPoints['points'][number] => [
      round1(p.ageDays),
      round3(p.strength),
      p.layer,
      p.band,
    ]);
    return { mode: 'points', maxAgeDays: scatter.maxAgeDays, points, ids: scatter.points.map((p) => p.id) };
  }
  const [buffer, episodic, semantic, trace] = scatter.cells;
  const cells: ScatterGrid['cells'] = [[...buffer], [...episodic], [...semantic], [...trace]];
  return { mode: 'grid', maxAgeDays: scatter.maxAgeDays, cols: SCATTER_COLS, rows: SCATTER_ROWS, cells };
}

/** Summary and scatter for one project key, or null when no live row has that project. */
export async function buildProjectDetail(
  reads: Pick<DashboardReads, 'project'>,
  stamp: Stamp,
  key: string,
): Promise<ProjectDetail | null> {
  const origin = originOfKey(key);
  if (origin === undefined) return null;
  const read = await reads.project(stamp.tenantId, origin, stamp.nowMs);
  if (read === null) return null;
  return { snapshotId: stamp.id, summary: summaryOf(read.tally), scatter: wireScatter(read.scatter) };
}
