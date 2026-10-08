// Pins what the seven typed-object modules do today, so folding them behind one shared core cannot change it unseen.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { insertEntity } from '../src/graph/write.js';
import { makeRoot } from './_helpers/make-root.js';
import {
  AuditTail, Transcript, TYPED_OBJECT_SPECS, mirrorLine, readGraphState, rowCounts, stableJson,
  type ObjectRow, type TypedObjectSpec,
} from './_helpers/typed-object-specs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function specOf(type: string): TypedObjectSpec {
  const spec = TYPED_OBJECT_SPECS.find((s) => s.type === type);
  if (!spec) throw new Error(`no typed-object spec named ${type}`);
  return spec;
}

const idsOf = (rows: readonly ObjectRow[]): string => rows.map((r) => r.id).join(',') || '(none)';
const sameRow = (a: ObjectRow | null, b: ObjectRow | null): boolean => JSON.stringify(a) === JSON.stringify(b);
const timeOf = (row: ObjectRow | null, key: string): string | undefined =>
  new RegExp(`"${key}":"([^"]+)"`).exec(JSON.stringify(row))?.[1];

/** Runs one type through every lifecycle step and returns what each step returned, threw and left in the store. */
function lifecycle(spec: TypedObjectSpec): string {
  const root = makeRoot('a8life');
  roots.push(root);
  const t = new Transcript();
  const audit = new AuditTail(root);
  const owners = new Map<string, string>();
  const graph = (label: string): void => {
    const state = readGraphState(root, owners);
    t.say(`graph ${label}`, `queue [${state.queue.join(' | ')}] entities [${state.entities.join(' | ')}]`);
  };
  const saved = (label: string, row: ObjectRow): ObjectRow => {
    if (row.memoryId) owners.set(row.memoryId, label);
    t.say(`save ${label}`, stableJson(row));
    t.each('  audit', audit.next());
    t.say('  mirror', mirrorLine(root, row.memoryId));
    return row;
  };

  const one = saved('one', spec.save(root, 'default', { label: 'one' }));
  graph('after the first save');
  const other = saved('other', spec.save(root, 'tenant-b', { label: 'other', actor: 'agent:a8', alt: true, extraTags: ['path:src'] }));
  t.say('load hit equals the saved row', sameRow(spec.load(root, 'default', one.id), one));
  t.say('load miss', stableJson(spec.load(root, 'default', 9999)));
  t.say('load other tenant', stableJson(spec.load(root, 'default', other.id)));

  let last = one;
  if (spec.canSupersede) {
    const two = saved('two', spec.save(root, 'default', { label: 'two', supersedes: one.id, actor: 'agent:a8' }));
    const oneAfter = spec.load(root, 'default', one.id);
    t.say('one after the supersede', stableJson(oneAfter));
    t.say('  supersededAt equals the successor createdAt', timeOf(oneAfter, 'supersededAt') === timeOf(two, 'createdAt'));
    t.say('  mirror', mirrorLine(root, one.memoryId));
    last = saved('three', spec.save(root, 'default', { label: 'three', supersedes: two.id }));
    const before = rowCounts(root, spec.table);
    t.fails('supersede a missing id', () => spec.save(root, 'default', { label: 'x', supersedes: 9999 }));
    t.fails('supersede a superseded row', () => spec.save(root, 'default', { label: 'x', supersedes: one.id }));
    t.fails('supersede another tenant row', () => spec.save(root, 'default', { label: 'x', supersedes: other.id }));
    t.fails('supersede the id the new row would take', () => spec.save(root, 'default', { label: 'x', supersedes: last.id + 1 }));
    t.say('  rows before the failed supersedes', before);
    t.say('  rows after equal rows before', rowCounts(root, spec.table) === before);
    t.fails('close a superseded row', () => spec.close(root, 'default', one.id));
  }

  if (spec.graphSource) {
    const source = { type: spec.graphSource, id: last.id };
    insertEntity(root, 'default', { entityType: spec.graphSource, name: 'target', sourceObject: source });
    insertEntity(root, 'tenant-b', { entityType: spec.graphSource, name: 'bystander', sourceObject: { ...source, id: other.id } });
  }
  graph('before the close');
  const closed = spec.close(root, 'default', last.id, 'agent:a8');
  t.say('close', stableJson(closed));
  t.each('  audit', audit.next());
  t.say('  mirror', mirrorLine(root, closed.memoryId));
  graph('after the close');
  t.fails('close again', () => spec.close(root, 'default', last.id));
  t.fails('close a missing id', () => spec.close(root, 'default', 9999));
  t.fails('close another tenant row', () => spec.close(root, 'default', other.id));
  t.each('  audit after the failed closes', audit.next());

  const all = spec.list(root, 'default');
  t.say('list', idsOf(all));
  t.say('  each listed row equals its loadById row', all.every((row) => sameRow(row, spec.load(root, 'default', row.id))));
  for (const status of ['active', 'superseded', 'closed', 'open', 'resolved', 'bogus', '']) {
    t.tries(`list status "${status}"`, () => idsOf(spec.list(root, 'default', { status })));
  }
  for (const limit of [1, 0, -1]) t.say(`list limit ${limit}`, idsOf(spec.list(root, 'default', { limit })));
  t.say('list other tenant', idsOf(spec.list(root, 'tenant-b')));

  const settled = rowCounts(root, spec.table);
  t.fails('save, empty tenant', () => spec.save(root, '', { label: 'x' }));
  t.fails('save, empty tenant and a blank field', () => spec.saveBlank(root, ''));
  t.fails('save, a blank field', () => spec.saveBlank(root, 'default'));
  t.fails('save, a session id as the tenant', () => spec.save(root, 'sess-abc', { label: 'x' }));
  t.fails('close, empty tenant', () => spec.close(root, '', one.id));
  t.fails('loadById, empty tenant', () => spec.load(root, '', one.id));
  t.fails('list, empty tenant', () => spec.list(root, ''));
  t.fails('list, empty tenant and a bogus status', () => spec.list(root, '', { status: 'bogus' }));
  t.say('  rows after the refused calls equal rows before', rowCounts(root, spec.table) === settled);
  return t.text();
}

describe('typed-object lifecycle, as the store modules behave today', () => {
  it('decision', () => {
    expect(lifecycle(specOf('decision'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing (one)","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli decision_create 1 {"decision_id":1,"has_context":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=decision confidence=verified tags=["decision"] content="Use Postgres for billing (one)\\n\\nContext: cheaper to run"
      graph after the first save: queue [default one distilled pending] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","decisionText":"Use Postgres for billing (other)","context":null,"status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 decision_create 2 {"decision_id":2,"has_context":false}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=decision confidence=verified tags=["decision","path:src"] content="Use Postgres for billing (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing (two)","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 decision_supersede 1 {"decision_id":1,"superseded_by":3}
        audit: default agent:a8 decision_create 3 {"decision_id":3,"has_context":true}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=decision confidence=verified tags=["decision"] content="Use Postgres for billing (two)\\n\\nContext: cheaper to run"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing (one)","context":"cheaper to run","status":"superseded","supersededBy":3,"supersededAt":"<ts>","closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=decision confidence=verified tags=["decision"] content="Use Postgres for billing (one)\\n\\nContext: cheaper to run"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing (three)","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli decision_supersede 3 {"decision_id":3,"superseded_by":4}
        audit: default cli decision_create 4 {"decision_id":4,"has_context":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=decision confidence=verified tags=["decision"] content="Use Postgres for billing (three)\\n\\nContext: cheaper to run"
      supersede a missing id: NotFoundError: saveDecision: decision 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: saveDecision: decision 1 is not active (status='superseded'); only active decisions can be superseded.
      supersede another tenant row: NotFoundError: saveDecision: decision 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: saveDecision: decision 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closeDecision: decision 1 is not active (status='superseded'); only active decisions can be closed.
      graph before the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending] entities [default decision#4 | tenant-b decision#2]
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing (three)","context":"cheaper to run","status":"closed","supersededBy":null,"supersededAt":null,"closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 decision_close 4 {"decision_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=decision confidence=verified tags=["decision"] content="Use Postgres for billing (three)\\n\\nContext: cheaper to run"
      graph after the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending | default three distilled pending] entities [tenant-b decision#2]
      close again: ConflictError: closeDecision: decision 4 is not active (status='closed'); only active decisions can be closed.
      close a missing id: NotFoundError: closeDecision: decision 9999 not found for tenant default
      close another tenant row: NotFoundError: closeDecision: decision 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadDecisions: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadDecisions: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadDecisions: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: saveDecision: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveDecision: tenantId is required (got string)
      save, a blank field: BadRequestError: saveDecision: decisionText is required
      save, a session id as the tenant: Error: saveDecision: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeDecision: tenantId is required (got string)
      loadById, empty tenant: Error: loadDecisionById: tenantId is required (got string)
      list, empty tenant: Error: loadDecisions: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadDecisions: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('incident', () => {
    expect(lifecycle(specOf('incident'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s (one)","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: default cli incident_open 1 {"incident_id":1,"has_context":true,"linked_memory_count":0}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=incident confidence=verified tags=["incident"] content="Checkout returned 500s (one)\\n\\nContext: after the deploy"
      graph after the first save: queue [] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","incidentText":"Checkout returned 500s (other)","context":null,"status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: tenant-b agent:a8 incident_open 2 {"incident_id":2,"has_context":false,"linked_memory_count":0}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=incident confidence=verified tags=["incident","path:src"] content="Checkout returned 500s (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      graph before the close: queue [] entities []
      close: {"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s (one)","context":"after the deploy","status":"closed","resolutionText":null,"resolvedAt":null,"closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: default agent:a8 incident_close 1 {"incident_id":1}
        mirror: tenant=default kind=distilled layer=semantic source=incident confidence=verified tags=["incident"] content="Checkout returned 500s (one)\\n\\nContext: after the deploy"
      graph after the close: queue [] entities []
      close again: ConflictError: closeIncident: incident 1 is already closed (status='closed'); only open or resolved incidents can be closed.
      close a missing id: NotFoundError: closeIncident: incident 9999 not found for tenant default
      close another tenant row: NotFoundError: closeIncident: incident 2 not found for tenant default
        audit after the failed closes: (none)
      list: 1
        each listed row equals its loadById row: true
      list status "active": BadRequestError: loadIncidents: status must be one of open|resolved|closed; got active
      list status "superseded": BadRequestError: loadIncidents: status must be one of open|resolved|closed; got superseded
      list status "closed": 1
      list status "open": (none)
      list status "resolved": (none)
      list status "bogus": BadRequestError: loadIncidents: status must be one of open|resolved|closed; got bogus
      list status "": 1
      list limit 1: 1
      list limit 0: (none)
      list limit -1: 1
      list other tenant: 2
      save, empty tenant: Error: saveIncident: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveIncident: tenantId is required (got string)
      save, a blank field: BadRequestError: saveIncident: incidentText is required
      save, a session id as the tenant: Error: saveIncident: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeIncident: tenantId is required (got string)
      loadById, empty tenant: Error: loadIncidentById: tenantId is required (got string)
      list, empty tenant: Error: loadIncidents: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadIncidents: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('process', () => {
    expect(lifecycle(specOf('process'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build (one)"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli process_create 1 {"process_id":1,"version":1,"step_count":2,"has_description":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=process confidence=verified tags=["process"] content="Release\\n\\n1. run the tests\\n2. tag the build (one)\\n\\nDescription: weekly cut"
      graph after the first save: queue [] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","processName":"Release","description":null,"steps":["run the tests","tag the build (other)"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 process_create 2 {"process_id":2,"version":1,"step_count":2,"has_description":false}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=process confidence=verified tags=["process","path:src"] content="Release\\n\\n1. run the tests\\n2. tag the build (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build (two)"],"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (two)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 process_supersede 1 {"process_id":1,"superseded_by":3,"new_version":2}
        audit: default agent:a8 process_create 3 {"process_id":3,"version":2,"step_count":2,"has_description":true}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=process confidence=verified tags=["process"] content="Release\\n\\n1. run the tests\\n2. tag the build (two)\\n\\nDescription: weekly cut"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build (one)"],"version":1,"status":"superseded","supersededBy":3,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=process confidence=verified tags=["process"] content="Release\\n\\n1. run the tests\\n2. tag the build (one)\\n\\nDescription: weekly cut"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build (three)"],"version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":null,"createdAt":"<ts>"}
        audit: default cli process_supersede 3 {"process_id":3,"superseded_by":4,"new_version":3}
        audit: default cli process_create 4 {"process_id":4,"version":3,"step_count":2,"has_description":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=process confidence=verified tags=["process"] content="Release\\n\\n1. run the tests\\n2. tag the build (three)\\n\\nDescription: weekly cut"
      supersede a missing id: NotFoundError: saveProcess: process 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: saveProcess: process 1 is not active (status='superseded'); only active processes can be superseded.
      supersede another tenant row: NotFoundError: saveProcess: process 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: saveProcess: process 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closeProcess: process 1 is not active (status='superseded'); only active processes can be closed.
      graph before the close: queue [] entities []
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build (three)"],"version":3,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 process_close 4 {"process_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=process confidence=verified tags=["process"] content="Release\\n\\n1. run the tests\\n2. tag the build (three)\\n\\nDescription: weekly cut"
      graph after the close: queue [] entities []
      close again: ConflictError: closeProcess: process 4 is not active (status='closed'); only active processes can be closed.
      close a missing id: NotFoundError: closeProcess: process 9999 not found for tenant default
      close another tenant row: NotFoundError: closeProcess: process 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadProcesses: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadProcesses: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadProcesses: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: saveProcess: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveProcess: tenantId is required (got string)
      save, a blank field: BadRequestError: saveProcess: processName is required
      save, a session id as the tenant: Error: saveProcess: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeProcess: tenantId is required (got string)
      loadById, empty tenant: Error: loadProcessById: tenantId is required (got string)
      list, empty tenant: Error: loadProcesses: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadProcesses: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('skill', () => {
    expect(lifecycle(specOf('skill'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path (one)","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli skill_create 1 {"skill_id":1,"version":1,"has_trigger":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=skill confidence=verified tags=["skill"] content="Review a migration\\n\\nWhen: a schema change\\n\\nCheck the down path (one)"
      graph after the first save: queue [] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","skillName":"Review a migration","instructions":"Check the down path (other)","trigger":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 skill_create 2 {"skill_id":2,"version":1,"has_trigger":false}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=skill confidence=verified tags=["skill","path:src"] content="Review a migration\\n\\nCheck the down path (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path (two)","trigger":"a schema change","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (two)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 skill_supersede 1 {"skill_id":1,"superseded_by":3,"new_version":2}
        audit: default agent:a8 skill_create 3 {"skill_id":3,"version":2,"has_trigger":true}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=skill confidence=verified tags=["skill"] content="Review a migration\\n\\nWhen: a schema change\\n\\nCheck the down path (two)"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path (one)","trigger":"a schema change","version":1,"status":"superseded","supersededBy":3,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=skill confidence=verified tags=["skill"] content="Review a migration\\n\\nWhen: a schema change\\n\\nCheck the down path (one)"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path (three)","trigger":"a schema change","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":null,"createdAt":"<ts>"}
        audit: default cli skill_supersede 3 {"skill_id":3,"superseded_by":4,"new_version":3}
        audit: default cli skill_create 4 {"skill_id":4,"version":3,"has_trigger":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=skill confidence=verified tags=["skill"] content="Review a migration\\n\\nWhen: a schema change\\n\\nCheck the down path (three)"
      supersede a missing id: NotFoundError: saveSkill: skill 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: saveSkill: skill 1 is not active (status='superseded'); only active skills can be superseded.
      supersede another tenant row: NotFoundError: saveSkill: skill 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: saveSkill: skill 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed.
      graph before the close: queue [] entities []
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path (three)","trigger":"a schema change","version":3,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 skill_close 4 {"skill_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=skill confidence=verified tags=["skill"] content="Review a migration\\n\\nWhen: a schema change\\n\\nCheck the down path (three)"
      graph after the close: queue [] entities []
      close again: ConflictError: closeSkill: skill 4 is not active (status='closed'); only active skills can be closed.
      close a missing id: NotFoundError: closeSkill: skill 9999 not found for tenant default
      close another tenant row: NotFoundError: closeSkill: skill 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadSkills: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadSkills: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadSkills: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: saveSkill: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveSkill: tenantId is required (got string)
      save, a blank field: BadRequestError: saveSkill: skillName is required
      save, a session id as the tenant: Error: saveSkill: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeSkill: tenantId is required (got string)
      loadById, empty tenant: Error: loadSkillById: tenantId is required (got string)
      list, empty tenant: Error: loadSkills: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadSkills: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('customer note', () => {
    expect(lifecycle(specOf('customer note'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email (one)","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli customer_note_create 1 {"note_id":1,"customer":"Acme Ltd","version":1}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd"] content="Acme Ltd\\n\\nPrefers email (one)"
      graph after the first save: queue [default one distilled pending] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","customer":"Acme Ltd","note":"Prefers email (other)","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 customer_note_create 2 {"note_id":2,"customer":"Acme Ltd","version":1}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd","path:src"] content="Acme Ltd\\n\\nPrefers email (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email (two)","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (two)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 customer_note_supersede 1 {"note_id":1,"superseded_by":3,"new_version":2}
        audit: default agent:a8 customer_note_create 3 {"note_id":3,"customer":"Acme Ltd","version":2}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd"] content="Acme Ltd\\n\\nPrefers email (two)"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email (one)","version":1,"status":"superseded","supersededBy":3,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd"] content="Acme Ltd\\n\\nPrefers email (one)"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email (three)","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":null,"createdAt":"<ts>"}
        audit: default cli customer_note_supersede 3 {"note_id":3,"superseded_by":4,"new_version":3}
        audit: default cli customer_note_create 4 {"note_id":4,"customer":"Acme Ltd","version":3}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd"] content="Acme Ltd\\n\\nPrefers email (three)"
      supersede a missing id: NotFoundError: saveCustomerNote: note 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: saveCustomerNote: note 1 is not active (status='superseded'); only active notes can be superseded.
      supersede another tenant row: NotFoundError: saveCustomerNote: note 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: saveCustomerNote: note 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed.
      graph before the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending] entities [default customer#4 | tenant-b customer#2]
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email (three)","version":3,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 customer_note_close 4 {"note_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:acme ltd"] content="Acme Ltd\\n\\nPrefers email (three)"
      graph after the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending | default three distilled pending] entities [tenant-b customer#2]
      close again: ConflictError: closeCustomerNote: note 4 is not active (status='closed'); only active notes can be closed.
      close a missing id: NotFoundError: closeCustomerNote: note 9999 not found for tenant default
      close another tenant row: NotFoundError: closeCustomerNote: note 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadCustomerNotes: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadCustomerNotes: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadCustomerNotes: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: saveCustomerNote: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveCustomerNote: tenantId is required (got string)
      save, a blank field: BadRequestError: saveCustomerNote: customer is required
      save, a session id as the tenant: Error: saveCustomerNote: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeCustomerNote: tenantId is required (got string)
      loadById, empty tenant: Error: loadCustomerNoteById: tenantId is required (got string)
      list, empty tenant: Error: loadCustomerNotes: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadCustomerNotes: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('policy', () => {
    expect(lifecycle(specOf('policy'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days (one)","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli policy_create 1 {"policy_id":1,"version":1,"open_ended":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=policy confidence=verified tags=["policy"] content="Retention\\n\\nDelete logs after 90 days (one)\\n\\nEffective: 2026-01-01T00:00:00.000Z onward"
      graph after the first save: queue [default one distilled pending] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","policyName":"Retention","policyText":"Delete logs after 90 days (other)","validFrom":"2026-01-01T00:00:00.000Z","validTo":"2027-01-01T00:00:00.000Z","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 policy_create 2 {"policy_id":2,"version":1,"open_ended":false}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=policy confidence=verified tags=["policy","path:src"] content="Retention\\n\\nDelete logs after 90 days (other)\\n\\nEffective: 2026-01-01T00:00:00.000Z to 2027-01-01T00:00:00.000Z"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days (two)","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (two)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 policy_supersede 1 {"policy_id":1,"superseded_by":3,"new_version":2}
        audit: default agent:a8 policy_create 3 {"policy_id":3,"version":2,"open_ended":true}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=policy confidence=verified tags=["policy"] content="Retention\\n\\nDelete logs after 90 days (two)\\n\\nEffective: 2026-01-01T00:00:00.000Z onward"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days (one)","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"superseded","supersededBy":3,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=policy confidence=verified tags=["policy"] content="Retention\\n\\nDelete logs after 90 days (one)\\n\\nEffective: 2026-01-01T00:00:00.000Z onward"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days (three)","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":null,"createdAt":"<ts>"}
        audit: default cli policy_supersede 3 {"policy_id":3,"superseded_by":4,"new_version":3}
        audit: default cli policy_create 4 {"policy_id":4,"version":3,"open_ended":true}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=policy confidence=verified tags=["policy"] content="Retention\\n\\nDelete logs after 90 days (three)\\n\\nEffective: 2026-01-01T00:00:00.000Z onward"
      supersede a missing id: NotFoundError: savePolicy: policy 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: savePolicy: policy 1 is not active (status='superseded'); only active policies can be superseded.
      supersede another tenant row: NotFoundError: savePolicy: policy 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: savePolicy: policy 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed.
      graph before the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending] entities [default policy#4 | tenant-b policy#2]
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days (three)","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":3,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 policy_close 4 {"policy_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=policy confidence=verified tags=["policy"] content="Retention\\n\\nDelete logs after 90 days (three)\\n\\nEffective: 2026-01-01T00:00:00.000Z onward"
      graph after the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending | default three distilled pending] entities [tenant-b policy#2]
      close again: ConflictError: closePolicy: policy 4 is not active (status='closed'); only active policies can be closed.
      close a missing id: NotFoundError: closePolicy: policy 9999 not found for tenant default
      close another tenant row: NotFoundError: closePolicy: policy 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadPolicies: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadPolicies: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadPolicies: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: savePolicy: tenantId is required (got string)
      save, empty tenant and a blank field: Error: savePolicy: tenantId is required (got string)
      save, a blank field: BadRequestError: savePolicy: policyName is required
      save, a session id as the tenant: Error: savePolicy: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closePolicy: tenantId is required (got string)
      loadById, empty tenant: Error: loadPolicyById: tenantId is required (got string)
      list, empty tenant: Error: loadPolicies: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadPolicies: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });

  it('project brief', () => {
    expect(lifecycle(specOf('project brief'))).toMatchInlineSnapshot(`
      "save one: {"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app (one)","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli project_brief_create 1 {"brief_id":1,"repo":"acme/web","version":1,"refreshed":false}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief"] content="acme/web\\n\\nStorefront app (one)"
      graph after the first save: queue [default one distilled pending] entities []
      save other: {"id":2,"memoryId":"<mem>","tenantId":"tenant-b","repo":"acme/web","summary":"Storefront app (other)","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: tenant-b agent:a8 project_brief_create 2 {"brief_id":2,"repo":"acme/web","version":1,"refreshed":true,"receipt_count":3}
        audit: tenant-b agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=tenant-b kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief","path:src"] content="acme/web\\n\\nStorefront app (other)"
      load hit equals the saved row: true
      load miss: null
      load other tenant: null
      save two: {"id":3,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app (two)","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (two)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 project_brief_supersede 1 {"brief_id":1,"superseded_by":3,"new_version":2,"refreshed":false}
        audit: default agent:a8 project_brief_create 3 {"brief_id":3,"repo":"acme/web","version":2,"refreshed":false}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief"] content="acme/web\\n\\nStorefront app (two)"
      one after the supersede: {"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app (one)","version":1,"status":"superseded","supersededBy":3,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        supersededAt equals the successor createdAt: true
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief"] content="acme/web\\n\\nStorefront app (one)"
      save three: {"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app (three)","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":null,"createdAt":"<ts>"}
        audit: default cli project_brief_supersede 3 {"brief_id":3,"superseded_by":4,"new_version":3,"refreshed":false}
        audit: default cli project_brief_create 4 {"brief_id":4,"repo":"acme/web","version":3,"refreshed":false}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief"] content="acme/web\\n\\nStorefront app (three)"
      supersede a missing id: NotFoundError: saveProjectBrief: brief 9999 to supersede not found for tenant default
      supersede a superseded row: ConflictError: saveProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be superseded.
      supersede another tenant row: NotFoundError: saveProjectBrief: brief 2 to supersede not found for tenant default
      supersede the id the new row would take: NotFoundError: saveProjectBrief: brief 5 to supersede not found for tenant default
        rows before the failed supersedes: objects=4 memories=4 audit=10
        rows after equal rows before: true
      close a superseded row: ConflictError: closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed.
      graph before the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending] entities [default project#4 | tenant-b project#2]
      close: {"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app (three)","version":3,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":"revised (three)","closedAt":"<ts>","createdAt":"<ts>"}
        audit: default agent:a8 project_brief_close 4 {"brief_id":4}
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief"] content="acme/web\\n\\nStorefront app (three)"
      graph after the close: queue [default one distilled pending | tenant-b other distilled pending | default two distilled pending | default three distilled pending | default three distilled pending] entities [tenant-b project#2]
      close again: ConflictError: closeProjectBrief: brief 4 is not active (status='closed'); only active briefs can be closed.
      close a missing id: NotFoundError: closeProjectBrief: brief 9999 not found for tenant default
      close another tenant row: NotFoundError: closeProjectBrief: brief 2 not found for tenant default
        audit after the failed closes: (none)
      list: 4,3,1
        each listed row equals its loadById row: true
      list status "active": (none)
      list status "superseded": 3,1
      list status "closed": 4
      list status "open": BadRequestError: loadProjectBriefs: status must be one of active|superseded|closed; got open
      list status "resolved": BadRequestError: loadProjectBriefs: status must be one of active|superseded|closed; got resolved
      list status "bogus": BadRequestError: loadProjectBriefs: status must be one of active|superseded|closed; got bogus
      list status "": 4,3,1
      list limit 1: 4
      list limit 0: (none)
      list limit -1: 4,3,1
      list other tenant: 2
      save, empty tenant: Error: saveProjectBrief: tenantId is required (got string)
      save, empty tenant and a blank field: Error: saveProjectBrief: tenantId is required (got string)
      save, a blank field: BadRequestError: saveProjectBrief: repo is required
      save, a session id as the tenant: Error: saveProjectBrief: tenantId looks like a session id ('sess-abc'). In v0.41+ these helpers take (hippoRoot, tenantId, ...). Pass the tenant id (e.g. 'default') and the session id separately.
      close, empty tenant: Error: closeProjectBrief: tenantId is required (got string)
      loadById, empty tenant: Error: loadProjectBriefById: tenantId is required (got string)
      list, empty tenant: Error: loadProjectBriefs: tenantId is required (got string)
      list, empty tenant and a bogus status: Error: loadProjectBriefs: tenantId is required (got string)
        rows after the refused calls equal rows before: true"
    `);
  });
});
