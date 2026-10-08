// Pins the corners the shared lifecycle run does not reach: each type's field checks, incident states and store edge cases.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { insertEntity } from '../src/graph/write.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { saveDecision } from '../src/decisions.js';
import { closeIncident, loadIncidents, resolveIncident, saveIncident } from '../src/incidents.js';
import { saveProcess, validateProcessSteps } from '../src/processes.js';
import { saveSkill } from '../src/skills.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { loadPolicyById, savePolicy } from '../src/policies.js';
import { refreshBrief, saveProjectBrief } from '../src/project-briefs.js';
import { makeRoot } from './_helpers/make-root.js';
import {
  AuditTail, Transcript, TYPED_OBJECT_SPECS, mirrorLine, readGraphState, rowCounts, stableJson, type ObjectRow,
} from './_helpers/typed-object-specs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = makeRoot('a8edge');
  roots.push(root);
  return root;
}

const T = 'default';
const long = (n: number): string => 'x'.repeat(n);
const idsOf = (rows: readonly ObjectRow[]): string => rows.map((r) => r.id).join(',') || '(none)';

type Refusal = readonly [label: string, call: () => void];

/** Runs calls the store should refuse and records each error, then whether any of them left a row behind. */
function refusals(root: string, table: string, cases: readonly Refusal[]): string {
  const t = new Transcript();
  const before = rowCounts(root, table);
  for (const [label, call] of cases) t.fails(label, call);
  t.say('rows after equal rows before', rowCounts(root, table) === before);
  return t.text();
}

describe('field checks of each save, as the store modules answer today', () => {
  it('saveDecision', () => {
    const root = freshRoot();
    expect(refusals(root, 'decisions', [
      ['empty text', () => saveDecision(root, T, { decisionText: '' })],
      // Blank and short text pass the module's own check; the mirror memory's length floor is what refuses them.
      ['blank text', () => saveDecision(root, T, { decisionText: '  ' })],
      ['two-character text', () => saveDecision(root, T, { decisionText: 'ab' })],
    ])).toMatchInlineSnapshot(`
      "empty text: BadRequestError: saveDecision: decisionText is required
      blank text: BadRequestError: Memory content too short (0 chars, minimum 3): ""
      two-character text: BadRequestError: Memory content too short (2 chars, minimum 3): "ab"
      rows after equal rows before: true"
    `);
    expect(stableJson(saveDecision(root, T, { decisionText: '  abc  ', context: '' }))).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"  abc  ","context":"","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}"`);
  });

  it('saveIncident', () => {
    const root = freshRoot();
    expect(refusals(root, 'incidents', [
      ['empty text', () => saveIncident(root, T, { incidentText: '' })],
      ['blank text', () => saveIncident(root, T, { incidentText: '  ' })],
      ['two-character text', () => saveIncident(root, T, { incidentText: 'ab' })],
    ])).toMatchInlineSnapshot(`
      "empty text: BadRequestError: saveIncident: incidentText is required
      blank text: BadRequestError: Memory content too short (0 chars, minimum 3): ""
      two-character text: BadRequestError: Memory content too short (2 chars, minimum 3): "ab"
      rows after equal rows before: true"
    `);
    expect(stableJson(saveIncident(root, T, { incidentText: '  abc  ', context: '' }))).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"  abc  ","context":"","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}"`);
  });

  it('saveProcess', () => {
    const root = freshRoot();
    expect(refusals(root, 'processes', [
      ['empty name', () => saveProcess(root, T, { processName: '', steps: ['a'] })],
      ['blank name', () => saveProcess(root, T, { processName: '  ', steps: ['a'] })],
      ['blank name and a blank step', () => saveProcess(root, T, { processName: ' ', steps: [' '] })],
      ['blank step', () => saveProcess(root, T, { processName: 'P', steps: ['a', ' '] })],
      ['step over the cap', () => saveProcess(root, T, { processName: 'P', steps: [long(2001)] })],
      ['too many steps', () => saveProcess(root, T, { processName: 'P', steps: Array.from({ length: 201 }, () => 'a') })],
      ['steps not an array', () => validateProcessSteps('nope')],
      ['step not a string', () => validateProcessSteps(['a', 2])],
    ])).toMatchInlineSnapshot(`
      "empty name: BadRequestError: saveProcess: processName is required
      blank name: BadRequestError: saveProcess: processName is required
      blank name and a blank step: BadRequestError: saveProcess: processName is required
      blank step: BadRequestError: saveProcess: step 2 is empty
      step over the cap: BadRequestError: saveProcess: step 1 exceeds the 2000-char cap
      too many steps: BadRequestError: saveProcess: steps exceeds the 200-step cap (got 201)
      steps not an array: BadRequestError: saveProcess: steps must be an array of strings
      step not a string: BadRequestError: saveProcess: step 2 is not a string
      rows after equal rows before: true"
    `);
    const padded = saveProcess(root, T, { processName: '  P  ', steps: ['  a  '], description: '', changeSummary: 'ignored on a create' });
    expect(stableJson(padded)).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"  P  ","description":"","steps":["a"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
    expect(stableJson(saveProcess(root, T, { processName: 'Empty', steps: [] }))).toMatchInlineSnapshot(`"{"id":2,"memoryId":"<mem>","tenantId":"default","processName":"Empty","description":null,"steps":[],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
  });

  it('saveSkill', () => {
    const root = freshRoot();
    expect(refusals(root, 'skills', [
      ['blank name', () => saveSkill(root, T, { skillName: '  ', instructions: 'i' })],
      ['blank name and blank instructions', () => saveSkill(root, T, { skillName: ' ', instructions: ' ' })],
      ['name with a newline', () => saveSkill(root, T, { skillName: 'a\nb', instructions: 'i' })],
      ['name over the cap', () => saveSkill(root, T, { skillName: long(257), instructions: 'i' })],
      ['empty instructions', () => saveSkill(root, T, { skillName: 'S', instructions: '' })],
      ['blank instructions', () => saveSkill(root, T, { skillName: 'S', instructions: '  ' })],
      ['instructions over the cap', () => saveSkill(root, T, { skillName: 'S', instructions: long(8193) })],
      ['trigger over the cap', () => saveSkill(root, T, { skillName: 'S', instructions: 'i', trigger: long(1025) })],
      ['trigger with a newline', () => saveSkill(root, T, { skillName: 'S', instructions: 'i', trigger: 'a\nb' })],
    ])).toMatchInlineSnapshot(`
      "blank name: BadRequestError: saveSkill: skillName is required
      blank name and blank instructions: BadRequestError: saveSkill: skillName is required
      name with a newline: BadRequestError: saveSkill: skillName must be a single line (no newlines)
      name over the cap: BadRequestError: saveSkill: skillName exceeds the 256-char cap
      empty instructions: BadRequestError: saveSkill: instructions are required
      blank instructions: BadRequestError: saveSkill: instructions are required
      instructions over the cap: BadRequestError: saveSkill: instructions exceed the 8192-char cap
      trigger over the cap: BadRequestError: saveSkill: trigger exceeds the 1024-char cap
      trigger with a newline: BadRequestError: saveSkill: trigger must be a single line (no newlines)
      rows after equal rows before: true"
    `);
    const padded = saveSkill(root, T, { skillName: '  S  ', instructions: '  i  ', trigger: '  ', changeSummary: 'ignored on a create' });
    expect(stableJson(padded)).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"S","instructions":"  i  ","trigger":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
  });

  it('saveCustomerNote', () => {
    const root = freshRoot();
    expect(refusals(root, 'customer_notes', [
      ['blank customer', () => saveCustomerNote(root, T, { customer: '  ', note: 'n' })],
      ['blank customer and blank note', () => saveCustomerNote(root, T, { customer: ' ', note: ' ' })],
      ['customer with a newline', () => saveCustomerNote(root, T, { customer: 'a\nb', note: 'n' })],
      ['customer over the cap', () => saveCustomerNote(root, T, { customer: long(257), note: 'n' })],
      ['empty note', () => saveCustomerNote(root, T, { customer: 'C', note: '' })],
      ['blank note', () => saveCustomerNote(root, T, { customer: 'C', note: '  ' })],
      ['note over the cap', () => saveCustomerNote(root, T, { customer: 'C', note: long(8193) })],
      ['change summary over the cap', () => saveCustomerNote(root, T, { customer: 'C', note: 'n', changeSummary: long(4097) })],
    ])).toMatchInlineSnapshot(`
      "blank customer: BadRequestError: saveCustomerNote: customer is required
      blank customer and blank note: BadRequestError: saveCustomerNote: customer is required
      customer with a newline: BadRequestError: saveCustomerNote: customer must be a single line (no newlines)
      customer over the cap: BadRequestError: saveCustomerNote: customer exceeds the 256-char cap
      empty note: BadRequestError: saveCustomerNote: note is required
      blank note: BadRequestError: saveCustomerNote: note is required
      note over the cap: BadRequestError: saveCustomerNote: note exceeds the 8192-char cap
      change summary over the cap: BadRequestError: saveCustomerNote: changeSummary exceeds the 4096-char cap
      rows after equal rows before: true"
    `);
    const padded = saveCustomerNote(root, T, { customer: '  Mixed Case  ', note: '  n  ', changeSummary: 'ignored on a create' });
    expect(stableJson(padded)).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Mixed Case","note":"  n  ","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
    expect(mirrorLine(root, padded.memoryId)).toMatchInlineSnapshot(`"tenant=default kind=distilled layer=semantic source=customer_note confidence=verified tags=["customer_note","customer:mixed case"] content="Mixed Case\\n\\n  n  ""`);
  });

  it('savePolicy', () => {
    const root = freshRoot();
    expect(refusals(root, 'policies', [
      ['blank name', () => savePolicy(root, T, { policyName: '  ', policyText: 't' })],
      ['blank name and blank text', () => savePolicy(root, T, { policyName: ' ', policyText: ' ' })],
      ['empty text', () => savePolicy(root, T, { policyName: 'P', policyText: '' })],
      ['blank text and a bad date', () => savePolicy(root, T, { policyName: 'P', policyText: ' ', validFrom: 'soon' })],
      ['unparseable validFrom', () => savePolicy(root, T, { policyName: 'P', policyText: 't', validFrom: 'soon' })],
      ['unparseable validTo', () => savePolicy(root, T, { policyName: 'P', policyText: 't', validFrom: '2026-01-01', validTo: 'later' })],
      ['both dates unparseable', () => savePolicy(root, T, { policyName: 'P', policyText: 't', validFrom: 'soon', validTo: 'later' })],
      ['validTo equal to validFrom', () => savePolicy(root, T, { policyName: 'P', policyText: 't', validFrom: '2026-01-01', validTo: '2026-01-01' })],
      ['validTo before validFrom', () => savePolicy(root, T, { policyName: 'P', policyText: 't', validFrom: '2026-06-01', validTo: '2026-01-01' })],
    ])).toMatchInlineSnapshot(`
      "blank name: BadRequestError: savePolicy: policyName is required
      blank name and blank text: BadRequestError: savePolicy: policyName is required
      empty text: BadRequestError: savePolicy: policyText is required
      blank text and a bad date: BadRequestError: savePolicy: policyText is required
      unparseable validFrom: BadRequestError: policy: invalid valid_from "soon" (expected an ISO-8601 date or datetime)
      unparseable validTo: BadRequestError: policy: invalid valid_to "later" (expected an ISO-8601 date or datetime)
      both dates unparseable: BadRequestError: policy: invalid valid_from "soon" (expected an ISO-8601 date or datetime)
      validTo equal to validFrom: BadRequestError: policy: valid_to (2026-01-01T00:00:00.000Z) must be strictly after valid_from (2026-01-01T00:00:00.000Z)
      validTo before validFrom: BadRequestError: policy: valid_to (2026-01-01T00:00:00.000Z) must be strictly after valid_from (2026-06-01T00:00:00.000Z)
      rows after equal rows before: true"
    `);
    const padded = savePolicy(root, T, { policyName: '  P  ', policyText: '  t  ', validFrom: '2026-02-30', changeSummary: 'ignored on a create' });
    expect(stableJson(padded)).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"  P  ","policyText":"  t  ","validFrom":"2026-03-02T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
  });

  it('saveProjectBrief and refreshBrief', () => {
    const root = freshRoot();
    expect(refusals(root, 'project_briefs', [
      ['blank repo', () => saveProjectBrief(root, T, { repo: '  ', summary: 's' })],
      ['blank repo and blank summary', () => saveProjectBrief(root, T, { repo: ' ', summary: ' ' })],
      ['repo with a newline', () => saveProjectBrief(root, T, { repo: 'a\nb', summary: 's' })],
      ['repo over the cap', () => saveProjectBrief(root, T, { repo: long(257), summary: 's' })],
      ['empty summary', () => saveProjectBrief(root, T, { repo: 'r', summary: '' })],
      ['blank summary', () => saveProjectBrief(root, T, { repo: 'r', summary: '  ' })],
      ['summary over the cap', () => saveProjectBrief(root, T, { repo: 'r', summary: long(8193) })],
      ['change summary over the cap', () => saveProjectBrief(root, T, { repo: 'r', summary: 's', changeSummary: long(4097) })],
      ['refresh, blank repo', () => refreshBrief(root, T, '  ')],
      ['refresh, empty tenant and blank repo', () => refreshBrief(root, '', '  ')],
    ])).toMatchInlineSnapshot(`
      "blank repo: BadRequestError: saveProjectBrief: repo is required
      blank repo and blank summary: BadRequestError: saveProjectBrief: repo is required
      repo with a newline: BadRequestError: saveProjectBrief: repo must be a single line (no newlines)
      repo over the cap: BadRequestError: saveProjectBrief: repo exceeds the 256-char cap
      empty summary: BadRequestError: saveProjectBrief: summary is required
      blank summary: BadRequestError: saveProjectBrief: summary is required
      summary over the cap: BadRequestError: saveProjectBrief: summary exceeds the 8192-char cap
      change summary over the cap: BadRequestError: saveProjectBrief: changeSummary exceeds the 4096-char cap
      refresh, blank repo: BadRequestError: refreshBrief: repo is required
      refresh, empty tenant and blank repo: Error: refreshBrief: tenantId is required (got string)
      rows after equal rows before: true"
    `);
    const padded = saveProjectBrief(root, T, { repo: '  Mixed/Case  ', summary: '  s  ', changeSummary: 'ignored on a create' });
    expect(stableJson(padded)).toMatchInlineSnapshot(`"{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"Mixed/Case","summary":"  s  ","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}"`);
  });
});

describe('incident states, as the store answers today', () => {
  it('resolve, then close from resolved and from open', () => {
    const root = freshRoot();
    const t = new Transcript();
    const a = saveIncident(root, T, { incidentText: 'Alpha outage' });
    const b = saveIncident(root, T, { incidentText: 'Beta outage' });
    const c = saveIncident(root, 'tenant-b', { incidentText: 'Gamma outage' });
    const audit = new AuditTail(root);
    audit.next();
    t.fails('resolve, empty text', () => resolveIncident(root, T, a.id, ''));
    t.fails('resolve, blank text', () => resolveIncident(root, T, a.id, '  '));
    t.fails('resolve, empty tenant and blank text', () => resolveIncident(root, '', a.id, ' '));
    t.fails('resolve, blank text on a missing id', () => resolveIncident(root, T, 9999, ' '));
    t.fails('resolve a missing id', () => resolveIncident(root, T, 9999, 'fixed'));
    t.fails('resolve another tenant row', () => resolveIncident(root, T, c.id, 'fixed'));
    t.each('  audit after the refused resolves', audit.next());
    t.say('resolve', stableJson(resolveIncident(root, T, a.id, '  rolled back  ', 'agent:a8')));
    t.each('  audit', audit.next());
    t.fails('resolve again', () => resolveIncident(root, T, a.id, 'fixed'));
    t.say('list resolved', idsOf(loadIncidents(root, T, { status: 'resolved' })));
    t.say('list open', idsOf(loadIncidents(root, T, { status: 'open' })));
    t.say('close from resolved', stableJson(closeIncident(root, T, a.id)));
    t.each('  audit', audit.next());
    t.say('close from open', stableJson(closeIncident(root, T, b.id, 'agent:a8')));
    t.each('  audit', audit.next());
    t.fails('resolve a closed incident', () => resolveIncident(root, T, b.id, 'fixed'));
    t.say('list closed', idsOf(loadIncidents(root, T, { status: 'closed' })));
    expect(t.text()).toMatchInlineSnapshot(`
      "resolve, empty text: BadRequestError: resolveIncident: resolutionText is required (non-empty)
      resolve, blank text: BadRequestError: resolveIncident: resolutionText is required (non-empty)
      resolve, empty tenant and blank text: Error: resolveIncident: tenantId is required (got string)
      resolve, blank text on a missing id: BadRequestError: resolveIncident: resolutionText is required (non-empty)
      resolve a missing id: NotFoundError: resolveIncident: incident 9999 not found for tenant default
      resolve another tenant row: NotFoundError: resolveIncident: incident 3 not found for tenant default
        audit after the refused resolves: (none)
      resolve: {"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Alpha outage","context":null,"status":"resolved","resolutionText":"  rolled back  ","resolvedAt":"<ts>","closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: default agent:a8 incident_resolve 1 {"incident_id":1}
      resolve again: ConflictError: resolveIncident: incident 1 is not open (status='resolved'); only open incidents can be resolved.
      list resolved: 1
      list open: 2
      close from resolved: {"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Alpha outage","context":null,"status":"closed","resolutionText":"  rolled back  ","resolvedAt":"<ts>","closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: default cli incident_close 1 {"incident_id":1}
      close from open: {"id":2,"memoryId":"<mem>","tenantId":"default","incidentText":"Beta outage","context":null,"status":"closed","resolutionText":null,"resolvedAt":null,"closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"}
        audit: default agent:a8 incident_close 2 {"incident_id":2}
      resolve a closed incident: ConflictError: resolveIncident: incident 2 is not open (status='closed'); only open incidents can be resolved.
      list closed: 2,1"
    `);
  });

  it('linked memory ids', () => {
    const root = freshRoot();
    const t = new Transcript();
    const mine = saveDecision(root, T, { decisionText: 'mine' }).memoryId ?? '';
    const theirs = saveDecision(root, 'tenant-b', { decisionText: 'theirs' }).memoryId ?? '';
    const audit = new AuditTail(root);
    audit.next();
    const before = rowCounts(root, 'incidents');
    t.fails('link a missing memory', () => saveIncident(root, T, { incidentText: 'Linked outage', linkedMemoryIds: ['mem_nope'] }));
    t.fails('link another tenant memory', () => saveIncident(root, T, { incidentText: 'Linked outage', linkedMemoryIds: [mine, theirs] }));
    t.say('rows after equal rows before', rowCounts(root, 'incidents') === before);
    t.each('  audit after the refused saves', audit.next());
    const linked = saveIncident(root, T, { incidentText: 'Linked outage', linkedMemoryIds: [mine, mine] });
    t.say('link the same memory twice', stableJson(linked));
    t.say('  both stored ids are the linked memory', linked.linkedMemoryIds.every((id) => id === mine));
    t.each('  audit', audit.next());
    expect(t.text()).toMatchInlineSnapshot(`
      "link a missing memory: NotFoundError: saveIncident: linked memory mem_nope not found for tenant default
      link another tenant memory: NotFoundError: saveIncident: linked memory <mem> not found for tenant default
      rows after equal rows before: true
        audit after the refused saves: (none)
      link the same memory twice: {"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Linked outage","context":null,"status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":["<mem>","<mem>"],"createdAt":"<ts>"}
        both stored ids are the linked memory: true
        audit: default cli incident_open 1 {"incident_id":1,"has_context":false,"linked_memory_count":2}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}"
    `);
  });
});

describe('store edge cases, as they behave today', () => {
  it('closing an object whose mirror memory is gone still clears its graph rows', () => {
    const t = new Transcript();
    for (const spec of TYPED_OBJECT_SPECS) {
      const root = freshRoot();
      const row = spec.save(root, T, { label: 'one' });
      const owners = new Map([[row.memoryId ?? '', 'one']]);
      const graph = (): string => {
        const state = readGraphState(root, owners);
        return `queue [${state.queue.join(' | ')}] entities [${state.entities.join(' | ')}]`;
      };
      t.say(`${spec.type}: after the save`, graph());
      deleteEntry(root, row.memoryId ?? '');
      t.say('  memoryId after the mirror is deleted', String(spec.load(root, T, row.id)?.memoryId));
      if (spec.graphSource) {
        insertEntity(root, T, { entityType: spec.graphSource, name: 'target', sourceObject: { type: spec.graphSource, id: row.id } });
      }
      t.say('  before the close', graph());
      const closed = spec.close(root, T, row.id);
      t.say('  closed', `status=${closed.status} memoryId=${closed.memoryId}`);
      t.say('  after the close', graph());
    }
    expect(t.text()).toMatchInlineSnapshot(`
      "decision: after the save: queue [default one distilled pending] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities [default decision#1]
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      incident: after the save: queue [] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities []
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      process: after the save: queue [] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities []
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      skill: after the save: queue [] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities []
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      customer note: after the save: queue [default one distilled pending] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities [default customer#1]
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      policy: after the save: queue [default one distilled pending] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities [default policy#1]
        closed: status=closed memoryId=null
        after the close: queue [] entities []
      project brief: after the save: queue [default one distilled pending] entities []
        memoryId after the mirror is deleted: null
        before the close: queue [] entities [default project#1]
        closed: status=closed memoryId=null
        after the close: queue [] entities []"
    `);
  });

  it('a policy saved with no validFrom reads the clock once for validFrom and createdAt', () => {
    const root = freshRoot();
    const first = savePolicy(root, T, { policyName: 'P', policyText: 'a' });
    expect(first.validFrom).toBe(first.createdAt);
    const second = savePolicy(root, T, { policyName: 'P', policyText: 'b', supersedesPolicyId: first.id });
    expect(second.validFrom).toBe(second.createdAt);
    expect(loadPolicyById(root, T, first.id)?.supersededAt).toBe(second.createdAt);
  });

  it('the customer and repo list filters skip an empty string and match case exactly', () => {
    const t = new Transcript();
    for (const spec of TYPED_OBJECT_SPECS) {
      if (spec.owner === null) continue;
      const root = freshRoot();
      const owner = spec.owner;
      const a = spec.save(root, T, { label: 'a' });
      spec.save(root, T, { label: 'b', owner: 'Elsewhere Co' });
      spec.save(root, T, { label: 'c', supersedes: a.id });
      spec.save(root, 'tenant-b', { label: 'd' });
      const listed = (label: string, args: { owner?: string; status?: string }): void => {
        t.tries(`${spec.type}: ${label}`, () => idsOf(spec.list(root, T, args)));
      };
      listed('no filter', {});
      listed('own value', { owner });
      listed('other value', { owner: 'Elsewhere Co' });
      listed('own value, upper case', { owner: owner.toUpperCase() });
      listed('own value, padded', { owner: ` ${owner} ` });
      listed('unknown value', { owner: 'nobody' });
      listed('empty string', { owner: '' });
      listed('own value and a status', { owner, status: 'superseded' });
      listed('empty string and an empty status', { owner: '', status: '' });
      listed('own value and a bogus status', { owner, status: 'bogus' });
    }
    expect(t.text()).toMatchInlineSnapshot(`
      "customer note: no filter: 3,2,1
      customer note: own value: 3,1
      customer note: other value: 2
      customer note: own value, upper case: (none)
      customer note: own value, padded: (none)
      customer note: unknown value: (none)
      customer note: empty string: 3,2,1
      customer note: own value and a status: 1
      customer note: empty string and an empty status: 3,2,1
      customer note: own value and a bogus status: BadRequestError: loadCustomerNotes: status must be one of active|superseded|closed; got bogus
      project brief: no filter: 3,2,1
      project brief: own value: 3,1
      project brief: other value: 2
      project brief: own value, upper case: (none)
      project brief: own value, padded: (none)
      project brief: unknown value: (none)
      project brief: empty string: 3,2,1
      project brief: own value and a status: 1
      project brief: empty string and an empty status: 3,2,1
      project brief: own value and a bogus status: BadRequestError: loadProjectBriefs: status must be one of active|superseded|closed; got bogus"
    `);
  });

  it('refreshBrief creates a first version, then supersedes it', () => {
    const root = freshRoot();
    const t = new Transcript();
    const audit = new AuditTail(root);
    const first = refreshBrief(root, T, '  Acme/Web  ');
    t.say('first refresh', stableJson(first));
    t.each('  audit', audit.next());
    t.say('  mirror', mirrorLine(root, first.memoryId));
    const second = refreshBrief(root, T, 'Acme/Web', 'agent:a8');
    t.say('second refresh', stableJson(second));
    t.each('  audit', audit.next());
    expect(t.text()).toMatchInlineSnapshot(`
      "first refresh: {"id":1,"memoryId":"<mem>","tenantId":"default","repo":"Acme/Web","summary":"# Project Brief: Acme/Web\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for Acme/Web._","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}
        audit: default cli project_brief_create 1 {"brief_id":1,"repo":"Acme/Web","version":1,"refreshed":true,"receipt_count":0}
        audit: default cli remember <mem> {"kind":"distilled","scope":null}
        mirror: tenant=default kind=distilled layer=semantic source=project_brief confidence=verified tags=["project_brief","path:acme/web"] content="Acme/Web\\n\\n# Project Brief: Acme/Web\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for Acme/Web._"
      second refresh: {"id":2,"memoryId":"<mem>","tenantId":"default","repo":"Acme/Web","summary":"# Project Brief: Acme/Web\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for Acme/Web._","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"}
        audit: default agent:a8 project_brief_supersede 1 {"brief_id":1,"superseded_by":2,"new_version":2,"refreshed":true,"receipt_count":0}
        audit: default agent:a8 project_brief_create 2 {"brief_id":2,"repo":"Acme/Web","version":2,"refreshed":true,"receipt_count":0}
        audit: default agent:a8 remember <mem> {"kind":"distilled","scope":null}"
    `);
  });
});
