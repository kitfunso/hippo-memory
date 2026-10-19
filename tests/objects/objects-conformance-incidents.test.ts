// The incident kind answers alike on hippo.db and on a store held in memory: open, resolve, close and links.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../_helpers/store-conformance.js';
import {
  T1,
  T2,
  T4,
  T5,
  conforms,
  close,
  byId,
  list,
  ids,
  mirrorViews,
  added,
  auditRow,
  opening,
  linkedTo,
  mirrorIdOf,
  openIncident,
  resolve,
  incidentOf,
  incidentMirror,
  opened,
  CLOSABLE,
  DRAINED,
  seededIncidents,
  SEED_CALLS,
  SEED_AUDIT_ROWS,
  useObjectsConformance,
} from '../_helpers/objects-conformance.js';

useObjectsConformance();

describe('Objects, the incident kind', () => {
  it('opens each row under the next id with its mirror, the open row ahead of the remember row, and reads it only inside its tenant', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      list('incident', { limit: 10 }),
      ...calls,
      byId('incident', 2),
      byId('incident', 4),
      byId('incident', 4, TENANT_B),
      byId('incident', 9),
      mirrorViews(openings.map(mirrorIdOf), TENANT_A),
      mirrorViews(openings.map(mirrorIdOf), TENANT_B),
    ]);
    const [o1, o2, o3, o4, o5, o6] = openings;
    expect(side.outcomes).toEqual([
      { value: [] },
      { value: incidentOf(1, o1) },
      { value: incidentOf(2, o2) },
      { value: incidentOf(3, o3) },
      { value: incidentOf(4, o4) },
      { value: incidentOf(5, o5) },
      { value: incidentOf(6, o6) },
      { value: incidentOf(2, o2, DRAINED) },
      { value: incidentOf(1, o1, { status: 'closed', closedAt: T4 }) },
      { value: incidentOf(2, o2, DRAINED) },
      { value: null },
      { value: incidentOf(4, o4) },
      { value: null },
      { value: [o1, o2, o3, o5, o6].map(incidentMirror) },
      { value: [incidentMirror(o4)] },
    ]);
    expect(added(side)).toEqual([
      ...opened(0, 1, o1),
      ...opened(2, 2, o2),
      ...opened(4, 3, o3),
      ...opened(6, 4, o4),
      ...opened(8, 5, o5),
      ...opened(10, 6, o6),
      auditRow(12, T4, 'incident_resolve', '2', { incident_id: 2 }),
      auditRow(13, T4, 'incident_close', '1', { incident_id: 1 }),
    ]);
    expect(added(side)[0].metadata).toEqual({ incident_id: 1, has_context: true, linked_memory_count: 0 });
  });

  it('reads the rows by status, newest first and under, at and over the cap, inside the tenant, and ignores a filter', async () => {
    const side = await conforms([
      ...seededIncidents().calls,
      ids('incident', { limit: 10 }),
      ids('incident', { limit: 5 }),
      ids('incident', { limit: 2 }),
      ids('incident', { status: 'open', limit: 10 }),
      ids('incident', { status: 'resolved', limit: 10 }),
      ids('incident', { status: 'closed', limit: 10 }),
      ids('incident', { limit: 10 }, TENANT_B),
      ids('incident', { filter: 'alpha', limit: 10 }),
      ids('incident', { limit: 2, after: { key: T2, id: 5 } }),
      ids('incident', { limit: 2, after: { key: T1, id: 2 } }),
      ids('incident', { limit: 2, after: { key: T1, id: 1 } }),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: [6, 5, 3, 2, 1] },
      { value: [6, 5, 3, 2, 1] },
      { value: [6, 5] },
      { value: [6, 5, 3] },
      { value: [2] },
      { value: [1] },
      { value: [4] },
      { value: [6, 5, 3, 2, 1] },
      { value: [3, 2] },
      { value: [1] },
      { value: [] },
    ]);
    expect(added(side)).toHaveLength(SEED_AUDIT_ROWS);
  });

  it('holds the linked ids as given: memories of the tenant, one cited twice, and the mirror the same open writes; an empty context counts as none', async () => {
    const { openings, calls } = seededIncidents();
    const bare = opening(7, { at: T5, context: '' });
    const cited = opening(8, {
      at: T5,
      context: 'after 1',
      links: [mirrorIdOf(openings[0]), mirrorIdOf(bare), mirrorIdOf(openings[0])],
    });
    const own = opening(9, { at: T5 });
    const selfCited = linkedTo(own, [mirrorIdOf(own)]);
    const theirs = opening(10, { at: T5, tenantId: TENANT_B, links: [mirrorIdOf(openings[3])] });
    const side = await conforms([
      ...calls,
      openIncident(bare),
      openIncident(cited),
      openIncident(selfCited),
      openIncident(theirs),
      byId('incident', 8),
      byId('incident', 10),
      byId('incident', 10, TENANT_B),
      mirrorViews([bare, cited, selfCited, theirs].map(mirrorIdOf)),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: incidentOf(7, bare) },
      { value: incidentOf(8, cited) },
      { value: incidentOf(9, selfCited) },
      { value: incidentOf(10, theirs) },
      { value: incidentOf(8, cited) },
      { value: null },
      { value: incidentOf(10, theirs) },
      { value: [theirs, bare, cited, selfCited].map(incidentMirror) },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([
      ...opened(14, 7, bare),
      ...opened(16, 8, cited),
      ...opened(18, 9, selfCited),
      ...opened(20, 10, theirs),
    ]);
    expect(added(side)[14].metadata).toEqual({ incident_id: 7, has_context: false, linked_memory_count: 0 });
    expect(added(side)[16].metadata).toEqual({ incident_id: 8, has_context: true, linked_memory_count: 3 });
  });

  it('refuses an open that links an id that is no memory of the tenant, naming the first one in the order given, and keeps no mirror, row, audit row or id', async () => {
    const { openings, calls } = seededIncidents();
    const [ours, , , foreign] = openings.map(mirrorIdOf);
    const refused = [
      opening(7, { at: T5, links: ['mem_never_written'] }),
      opening(8, { at: T5, links: [ours, foreign] }),
      opening(9, { at: T5, links: ['mem_gone_b', foreign, 'mem_gone_a'] }),
      opening(10, { at: T5, tenantId: TENANT_B, links: [foreign, ours] }),
    ];
    const next = opening(11, { at: T5, links: [ours] });
    const side = await conforms([
      ...calls,
      ...refused.map(openIncident),
      mirrorViews(refused.map(mirrorIdOf)),
      ids('incident', { limit: 10 }),
      ids('incident', { limit: 10 }, TENANT_B),
      openIncident(next),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: { refused: 'unlinked', memoryId: 'mem_never_written' } },
      { value: { refused: 'unlinked', memoryId: foreign } },
      { value: { refused: 'unlinked', memoryId: 'mem_gone_b' } },
      { value: { refused: 'unlinked', memoryId: ours } },
      { value: [] },
      { value: [6, 5, 3, 2, 1] },
      { value: [4] },
      { value: incidentOf(7, next) },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual(opened(14, 7, next));
  });

  it('resolve moves an open row to resolved once with one resolve row; a resolved, a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      ...calls,
      resolve(3, T5, 'restarted the pool'),
      resolve(3, T5, 'again'),
      resolve(2, T5, 'again'),
      resolve(1, T5, 'again'),
      resolve(9, T5, 'none'),
      resolve(4, T5, 'not ours'),
      byId('incident', 3),
      byId('incident', 2),
      byId('incident', 1),
      byId('incident', 4, TENANT_B),
      ids('incident', { status: 'resolved', limit: 10 }),
    ]);
    const restarted = incidentOf(3, openings[2], {
      status: 'resolved',
      resolutionText: 'restarted the pool',
      resolvedAt: T5,
    });
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: restarted },
      { value: { refused: 'status', status: 'resolved' } },
      { value: { refused: 'status', status: 'resolved' } },
      { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'missing' } },
      { value: restarted },
      { value: incidentOf(2, openings[1], DRAINED) },
      { value: incidentOf(1, openings[0], { status: 'closed', closedAt: T4 }) },
      { value: incidentOf(4, openings[3]) },
      { value: [3, 2] },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([auditRow(14, T5, 'incident_resolve', '3', { incident_id: 3 })]);
  });

  it('close retires an open and a resolved row with one close row each; a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const { openings, calls } = seededIncidents();
    const side = await conforms([
      ...calls,
      close('incident', 3, T5, CLOSABLE),
      close('incident', 2, T5, CLOSABLE),
      close('incident', 1, T5, CLOSABLE),
      close('incident', 3, T5, CLOSABLE),
      close('incident', 9, T5, CLOSABLE),
      close('incident', 4, T5, CLOSABLE),
      close('incident', 5, T5, ['resolved']),
      byId('incident', 4, TENANT_B),
      byId('incident', 5),
      ids('incident', { status: 'closed', limit: 10 }),
    ]);
    expect(side.outcomes.slice(SEED_CALLS)).toEqual([
      { value: incidentOf(3, openings[2], { status: 'closed', closedAt: T5 }) },
      { value: incidentOf(2, openings[1], { ...DRAINED, status: 'closed', closedAt: T5 }) },
      { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'status', status: 'open' } },
      { value: incidentOf(4, openings[3]) },
      { value: incidentOf(5, openings[4]) },
      { value: [3, 2, 1] },
    ]);
    expect(added(side).slice(SEED_AUDIT_ROWS)).toEqual([
      auditRow(14, T5, 'incident_close', '3', { incident_id: 3 }),
      auditRow(15, T5, 'incident_close', '2', { incident_id: 2 }),
    ]);
  });
});
