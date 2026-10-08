// Pins the status code and JSON body of every typed-object route, so one shared handler cannot change a reply unseen.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectApi, routeOf, type Body, type Caller, type Reply, type RouteSpec } from './_helpers/typed-object-http.js';
import { Transcript } from './_helpers/typed-object-specs.js';

let api: ObjectApi;
beforeAll(async () => {
  api = await ObjectApi.start('a8routes');
});
afterAll(async () => {
  await api.stop();
});

type Say = (label: string, method: string, path: string, body?: Body, caller?: Caller) => Promise<Reply>;

const memoryIdOf = (reply: Reply): string => /"memoryId":"([^"]+)"/.exec(reply.text)?.[1] ?? '(no memory id)';

/** The steps every type shares. Ids: 1 default, 2 the other tenant, 3 default with no key, 4 the successor of 1. */
async function sharedSteps(spec: RouteSpec, say: Say): Promise<void> {
  const p = spec.path;
  await say('create', 'POST', p, spec.create);
  await say('create as the other tenant', 'POST', p, spec.create, 'tenant-b');
  await say('create with no key on loopback', 'POST', p, spec.create, 'nobody');
  await say('get', 'GET', `${p}/1`);
  await say('get, missing id', 'GET', `${p}/9999`);
  await say('get, other tenant id', 'GET', `${p}/2`);
  await say('get, id that is not a number', 'GET', `${p}/abc`);
  await say('get, negative id', 'GET', `${p}/-1`);
  if (spec.revise) {
    await say('supersede', 'POST', `${p}/1/supersede`, spec.revise);
    await say('supersede again', 'POST', `${p}/1/supersede`, spec.revise);
    await say('supersede, missing id', 'POST', `${p}/9999/supersede`, spec.revise);
    await say('supersede, other tenant id', 'POST', `${p}/2/supersede`, spec.revise);
    await say('get the superseded row', 'GET', `${p}/1`);
    await say('close a superseded row', 'POST', `${p}/1/close`);
  }
  await say('close', 'POST', `${p}/3/close`);
  await say('close again', 'POST', `${p}/3/close`);
  await say('close, missing id', 'POST', `${p}/9999/close`);
  await say('close, other tenant id', 'POST', `${p}/2/close`);
  await say('close, id that is not a number', 'POST', `${p}/abc/close`);
  if (spec.revise) await say('supersede a closed row', 'POST', `${p}/3/supersede`, spec.revise);
}

async function decisionSteps(say: Say): Promise<void> {
  const text = 'Ship on Fridays';
  await say('create naming a missing predecessor', 'POST', '/v1/decisions', { text, supersedesDecisionId: 9999 });
  await say('create naming an other tenant predecessor', 'POST', '/v1/decisions', { text, supersedesDecisionId: 2 });
  await say('create naming a closed predecessor', 'POST', '/v1/decisions', { text, supersedesDecisionId: 3 });
  await say('create naming an active predecessor', 'POST', '/v1/decisions', { text, supersedesDecisionId: 4 });
  await say('get that predecessor', 'GET', '/v1/decisions/4');
}

async function incidentSteps(say: Say): Promise<void> {
  const p = '/v1/incidents';
  const resolution = { resolutionText: 'Rolled the deploy back' };
  const own = await say('create a second incident', 'POST', p, { text: 'Search is slow' });
  await say('resolve', 'POST', `${p}/4/resolve`, resolution);
  await say('resolve again', 'POST', `${p}/4/resolve`, resolution);
  await say('resolve, missing id', 'POST', `${p}/9999/resolve`, resolution);
  await say('resolve, other tenant id', 'POST', `${p}/2/resolve`, resolution);
  await say('resolve a closed incident', 'POST', `${p}/3/resolve`, resolution);
  await say('list, status=resolved', 'GET', `${p}?status=resolved`);
  await say('list, status=active', 'GET', `${p}?status=active`);
  await say('close a resolved incident', 'POST', `${p}/4/close`);
  const theirs = await say('get the other tenant incident as that tenant', 'GET', `${p}/2`, undefined, 'tenant-b');
  await say('create linked to a memory', 'POST', p, { text: 'Search is down', linkedMemoryIds: [memoryIdOf(own)] });
  await say('create linked to a missing memory', 'POST', p, { text: 'Search is down', linkedMemoryIds: ['mem_nope'] });
  await say('create linked to an other tenant memory', 'POST', p, { text: 'Search is down', linkedMemoryIds: [memoryIdOf(theirs)] });
}

async function policySteps(say: Say): Promise<void> {
  const p = '/v1/policies/asof';
  await say('as of a date in the first version', 'GET', `${p}?date=2026-03-01`);
  await say('as of a date in the second version', 'GET', `${p}?date=2026-07-01`);
  await say('as of a date before any version', 'GET', `${p}?date=2025-01-01`);
  await say('as of, by name', 'GET', `${p}?date=2026-07-01&name=Retention`);
  await say('as of, by a name in another case', 'GET', `${p}?date=2026-07-01&name=retention`);
  await say('as of, by an unknown name', 'GET', `${p}?date=2026-07-01&name=nope`);
  await say('as of, by an empty name', 'GET', `${p}?date=2026-07-01&name=`);
  await say('as of, no date', 'GET', p);
  await say('as of, empty date', 'GET', `${p}?date=`);
  await say('as of, a date that does not parse', 'GET', `${p}?date=soon`);
  vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
  try {
    await say('no key: as of, no date', 'GET', p, undefined, 'nobody');
    await say('no key: as of, a date', 'GET', `${p}?date=2026-07-01`, undefined, 'nobody');
    await say('no key: as of, a date that does not parse', 'GET', `${p}?date=soon`, undefined, 'nobody');
  } finally {
    vi.unstubAllEnvs();
  }
}

async function skillSteps(say: Say): Promise<void> {
  await say('export', 'GET', '/v1/skills/export');
  await say('export as the other tenant', 'GET', '/v1/skills/export', undefined, 'tenant-b');
  await say('export with a POST', 'POST', '/v1/skills/export');
}

async function customerNoteSteps(say: Say): Promise<void> {
  const p = '/v1/customer-notes';
  await say('create for a second customer', 'POST', p, { customer: '  Globex  ', note: 'Wants invoices monthly' });
  await say('list, customer=Globex', 'GET', `${p}?customer=Globex`);
  await say('list, customer padded with spaces', 'GET', `${p}?customer=%20Globex%20`);
  await say('list, customer in another case', 'GET', `${p}?customer=globex`);
  await say('list, unknown customer', 'GET', `${p}?customer=nope`);
  await say('list, empty customer', 'GET', `${p}?customer=`);
  await say('list, blank customer', 'GET', `${p}?customer=%20%20`);
  await say('list, customer and status', 'GET', `${p}?customer=Acme%20Ltd&status=closed`);
}

async function projectBriefSteps(say: Say): Promise<void> {
  const p = '/v1/project-briefs';
  await say('refresh, dry run', 'POST', `${p}/refresh`, { repo: 'acme/api', dryRun: true });
  await say('list after the dry run', 'GET', `${p}?repo=acme/api`);
  await say('refresh', 'POST', `${p}/refresh`, { repo: 'acme/api' });
  await say('refresh again', 'POST', `${p}/refresh`, { repo: 'acme/api', dryRun: false });
  // Documents current behaviour: only the boolean true is a dry run, so the string writes a new version.
  await say('refresh, dryRun as a string', 'POST', `${p}/refresh`, { repo: 'acme/api', dryRun: 'true' });
  await say('list, repo=acme/api', 'GET', `${p}?repo=acme/api&status=active`);
  await say('list, repo padded with spaces', 'GET', `${p}?repo=%20acme/api%20&status=active`);
  await say('list, repo in another case', 'GET', `${p}?repo=ACME/API&status=active`);
  await say('list, unknown repo', 'GET', `${p}?repo=nope`);
  await say('list, empty repo', 'GET', `${p}?repo=&status=active`);
  await say('list, blank repo', 'GET', `${p}?repo=%20%20&status=active`);
}

const NO_EXTRA_STEPS = async (): Promise<void> => {};
const EXTRA_STEPS: ReadonlyMap<string, (say: Say) => Promise<void>> = new Map([
  ['decision', decisionSteps],
  ['incident', incidentSteps],
  ['policy', policySteps],
  ['skill', skillSteps],
  ['customer note', customerNoteSteps],
  ['project brief', projectBriefSteps],
]);

async function transcript(type: string): Promise<string> {
  const spec = routeOf(type);
  const t = new Transcript();
  const say: Say = async (label, method, path, body, caller) => {
    const reply = await api.send(method, path, body, caller);
    t.say(label, reply.line);
    return reply;
  };
  await sharedSteps(spec, say);
  await (EXTRA_STEPS.get(type) ?? NO_EXTRA_STEPS)(say);
  return t.text();
}

describe('typed-object routes: create, get, supersede, close', () => {
  it('decision', async () => {
    expect(await transcript('decision')).toMatchInlineSnapshot(`
      "create: 201 {"decision":{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"decision":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"decision":{"id":3,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"decision":{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"decision 9999 not found"}
      get, other tenant id: 404 {"error":"decision 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 201 {"decision":{"id":4,"memoryId":"<mem>","tenantId":"default","decisionText":"Use SQLite for billing","context":"one file to back up","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"saveDecision: decision 1 is not active (status='superseded'); only active decisions can be superseded."}
      supersede, missing id: 404 {"error":"saveDecision: decision 9999 to supersede not found for tenant default"}
      supersede, other tenant id: 404 {"error":"saveDecision: decision 2 to supersede not found for tenant default"}
      get the superseded row: 200 {"decision":{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"superseded","supersededBy":4,"supersededAt":"<ts>","closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closeDecision: decision 1 is not active (status='superseded'); only active decisions can be closed."}
      close: 200 {"decision":{"id":3,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"closed","supersededBy":null,"supersededAt":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closeDecision: decision 3 is not active (status='closed'); only active decisions can be closed."}
      close, missing id: 404 {"error":"closeDecision: decision 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeDecision: decision 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"saveDecision: decision 3 is not active (status='closed'); only active decisions can be superseded."}
      create naming a missing predecessor: 409 {"error":"saveDecision: decision 9999 to supersede not found for tenant default"}
      create naming an other tenant predecessor: 409 {"error":"saveDecision: decision 2 to supersede not found for tenant default"}
      create naming a closed predecessor: 409 {"error":"saveDecision: decision 3 is not active (status='closed'); only active decisions can be superseded."}
      create naming an active predecessor: 201 {"decision":{"id":5,"memoryId":"<mem>","tenantId":"default","decisionText":"Ship on Fridays","context":null,"status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      get that predecessor: 200 {"decision":{"id":4,"memoryId":"<mem>","tenantId":"default","decisionText":"Use SQLite for billing","context":"one file to back up","status":"superseded","supersededBy":5,"supersededAt":"<ts>","closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('incident', async () => {
    expect(await transcript('incident')).toMatchInlineSnapshot(`
      "create: 201 {"incident":{"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      create as the other tenant: 201 {"incident":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"incident":{"id":3,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      get: 200 {"incident":{"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"incident 9999 not found"}
      get, other tenant id: 404 {"error":"incident 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      close: 200 {"incident":{"id":3,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"closed","resolutionText":null,"resolvedAt":null,"closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"}}
      close again: 409 {"error":"closeIncident: incident 3 is already closed (status='closed'); only open or resolved incidents can be closed."}
      close, missing id: 404 {"error":"closeIncident: incident 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeIncident: incident 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      create a second incident: 201 {"incident":{"id":4,"memoryId":"<mem>","tenantId":"default","incidentText":"Search is slow","context":null,"status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      resolve: 200 {"incident":{"id":4,"memoryId":"<mem>","tenantId":"default","incidentText":"Search is slow","context":null,"status":"resolved","resolutionText":"Rolled the deploy back","resolvedAt":"<ts>","closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      resolve again: 409 {"error":"resolveIncident: incident 4 is not open (status='resolved'); only open incidents can be resolved."}
      resolve, missing id: 404 {"error":"resolveIncident: incident 9999 not found for tenant default"}
      resolve, other tenant id: 404 {"error":"resolveIncident: incident 2 not found for tenant default"}
      resolve a closed incident: 409 {"error":"resolveIncident: incident 3 is not open (status='closed'); only open incidents can be resolved."}
      list, status=resolved: 200 {"incidents":[{"id":4,"memoryId":"<mem>","tenantId":"default","incidentText":"Search is slow","context":null,"status":"resolved","resolutionText":"Rolled the deploy back","resolvedAt":"<ts>","closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}],"next_cursor":null}
      list, status=active: 400 {"error":"status must be one of: open | resolved | closed | all (got \\"active\\")"}
      close a resolved incident: 200 {"incident":{"id":4,"memoryId":"<mem>","tenantId":"default","incidentText":"Search is slow","context":null,"status":"closed","resolutionText":"Rolled the deploy back","resolvedAt":"<ts>","closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"}}
      get the other tenant incident as that tenant: 200 {"incident":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      create linked to a memory: 201 {"incident":{"id":5,"memoryId":"<mem>","tenantId":"default","incidentText":"Search is down","context":null,"status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":["<mem>"],"createdAt":"<ts>"}}
      create linked to a missing memory: 409 {"error":"saveIncident: linked memory mem_nope not found for tenant default"}
      create linked to an other tenant memory: 409 {"error":"saveIncident: linked memory <mem> not found for tenant default"}"
    `);
  });

  it('process', async () => {
    expect(await transcript('process')).toMatchInlineSnapshot(`
      "create: 201 {"process":{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"process":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"process":{"id":3,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"process":{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"process 9999 not found"}
      get, other tenant id: 404 {"error":"process 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 200 {"process":{"id":4,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":null,"steps":["run the tests","sign and tag the build"],"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"sign the build","closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"saveProcess: process 1 is not active (status='superseded'); only active processes can be superseded."}
      supersede, missing id: 404 {"error":"process 9999 not found"}
      supersede, other tenant id: 404 {"error":"process 2 not found"}
      get the superseded row: 200 {"process":{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closeProcess: process 1 is not active (status='superseded'); only active processes can be closed."}
      close: 200 {"process":{"id":3,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closeProcess: process 3 is not active (status='closed'); only active processes can be closed."}
      close, missing id: 404 {"error":"closeProcess: process 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeProcess: process 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"saveProcess: process 3 is not active (status='closed'); only active processes can be superseded."}"
    `);
  });

  it('skill', async () => {
    expect(await transcript('skill')).toMatchInlineSnapshot(`
      "create: 201 {"skill":{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"skill":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"skill":{"id":3,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"skill":{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"skill 9999 not found"}
      get, other tenant id: 404 {"error":"skill 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 200 {"skill":{"id":4,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check both paths","trigger":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"both ways","closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"saveSkill: skill 1 is not active (status='superseded'); only active skills can be superseded."}
      supersede, missing id: 404 {"error":"skill 9999 not found"}
      supersede, other tenant id: 404 {"error":"skill 2 not found"}
      get the superseded row: 200 {"skill":{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed."}
      close: 200 {"skill":{"id":3,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closeSkill: skill 3 is not active (status='closed'); only active skills can be closed."}
      close, missing id: 404 {"error":"closeSkill: skill 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeSkill: skill 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"saveSkill: skill 3 is not active (status='closed'); only active skills can be superseded."}
      export: 200 {"markdown":"## Review a migration\\n\\nCheck both paths"}
      export as the other tenant: 200 {"markdown":"## Review a migration\\n\\n**When:** a schema change\\n\\nCheck the down path"}
      export with a POST: 404 {"error":"not found"}"
    `);
  });

  it('customer note', async () => {
    expect(await transcript('customer note')).toMatchInlineSnapshot(`
      "create: 201 {"note":{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"note":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"note":{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"note":{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"customer note 9999 not found"}
      get, other tenant id: 404 {"error":"customer note 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 200 {"note":{"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers a call","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"asked on the phone","closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"saveCustomerNote: note 1 is not active (status='superseded'); only active notes can be superseded."}
      supersede, missing id: 404 {"error":"customer note 9999 not found"}
      supersede, other tenant id: 404 {"error":"customer note 2 not found"}
      get the superseded row: 200 {"note":{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed."}
      close: 200 {"note":{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closeCustomerNote: note 3 is not active (status='closed'); only active notes can be closed."}
      close, missing id: 404 {"error":"closeCustomerNote: note 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeCustomerNote: note 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"saveCustomerNote: note 3 is not active (status='closed'); only active notes can be superseded."}
      create for a second customer: 201 {"note":{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Globex","note":"Wants invoices monthly","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      list, customer=Globex: 200 {"notes":[{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Globex","note":"Wants invoices monthly","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, customer padded with spaces: 200 {"notes":[{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Globex","note":"Wants invoices monthly","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, customer in another case: 200 {"notes":[],"next_cursor":null}
      list, unknown customer: 200 {"notes":[],"next_cursor":null}
      list, empty customer: 200 {"notes":[{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Globex","note":"Wants invoices monthly","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers a call","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"asked on the phone","closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, blank customer: 200 {"notes":[{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Globex","note":"Wants invoices monthly","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers a call","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"asked on the phone","closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, customer and status: 200 {"notes":[{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}],"next_cursor":null}"
    `);
  });

  it('policy', async () => {
    expect(await transcript('policy')).toMatchInlineSnapshot(`
      "create: 201 {"policy":{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"policy":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"policy":{"id":3,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"policy":{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"policy 9999 not found"}
      get, other tenant id: 404 {"error":"policy 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 200 {"policy":{"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 30 days","validFrom":"2026-06-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"shorter","closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"savePolicy: policy 1 is not active (status='superseded'); only active policies can be superseded."}
      supersede, missing id: 404 {"error":"policy 9999 not found"}
      supersede, other tenant id: 404 {"error":"policy 2 not found"}
      get the superseded row: 200 {"policy":{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed."}
      close: 200 {"policy":{"id":3,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closePolicy: policy 3 is not active (status='closed'); only active policies can be closed."}
      close, missing id: 404 {"error":"closePolicy: policy 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closePolicy: policy 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"savePolicy: policy 3 is not active (status='closed'); only active policies can be superseded."}
      as of a date in the first version: 200 {"policies":[{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}]}
      as of a date in the second version: 200 {"policies":[{"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 30 days","validFrom":"2026-06-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"shorter","closedAt":null,"createdAt":"<ts>"}]}
      as of a date before any version: 200 {"policies":[]}
      as of, by name: 200 {"policies":[{"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 30 days","validFrom":"2026-06-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"shorter","closedAt":null,"createdAt":"<ts>"}]}
      as of, by a name in another case: 200 {"policies":[]}
      as of, by an unknown name: 200 {"policies":[]}
      as of, by an empty name: 200 {"policies":[]}
      as of, no date: 400 {"error":"date is required (ISO-8601 valid-time)"}
      as of, empty date: 400 {"error":"date is required (ISO-8601 valid-time)"}
      as of, a date that does not parse: 400 {"error":"policy: invalid asOfDate \\"soon\\" (expected an ISO-8601 date or datetime)"}
      no key: as of, no date: 400 {"error":"date is required (ISO-8601 valid-time)"}
      no key: as of, a date: 401 {"error":"auth required"}
      no key: as of, a date that does not parse: 401 {"error":"auth required"}"
    `);
  });

  it('project brief', async () => {
    expect(await transcript('project brief')).toMatchInlineSnapshot(`
      "create: 201 {"brief":{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create as the other tenant: 201 {"brief":{"id":2,"memoryId":"<mem>","tenantId":"tenant-b","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create with no key on loopback: 201 {"brief":{"id":3,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get: 200 {"brief":{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      get, missing id: 404 {"error":"project brief 9999 not found"}
      get, other tenant id: 404 {"error":"project brief 2 not found"}
      get, id that is not a number: 404 {"error":"not found"}
      get, negative id: 404 {"error":"not found"}
      supersede: 200 {"brief":{"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront and admin app","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"admin added","closedAt":null,"createdAt":"<ts>"}}
      supersede again: 409 {"error":"saveProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be superseded."}
      supersede, missing id: 404 {"error":"project brief 9999 not found"}
      supersede, other tenant id: 404 {"error":"project brief 2 not found"}
      get the superseded row: 200 {"brief":{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"superseded","supersededBy":4,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      close a superseded row: 409 {"error":"closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed."}
      close: 200 {"brief":{"id":3,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"}}
      close again: 409 {"error":"closeProjectBrief: brief 3 is not active (status='closed'); only active briefs can be closed."}
      close, missing id: 404 {"error":"closeProjectBrief: brief 9999 not found for tenant default"}
      close, other tenant id: 404 {"error":"closeProjectBrief: brief 2 not found for tenant default"}
      close, id that is not a number: 404 {"error":"not found"}
      supersede a closed row: 409 {"error":"saveProjectBrief: brief 3 is not active (status='closed'); only active briefs can be superseded."}
      refresh, dry run: 200 {"markdown":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","receiptCount":0}
      list after the dry run: 200 {"briefs":[],"next_cursor":null}
      refresh: 200 {"brief":{"id":5,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      refresh again: 200 {"brief":{"id":6,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"}}
      refresh, dryRun as a string: 200 {"brief":{"id":7,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"}}
      list, repo=acme/api: 200 {"briefs":[{"id":7,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, repo padded with spaces: 200 {"briefs":[{"id":7,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, repo in another case: 200 {"briefs":[],"next_cursor":null}
      list, unknown repo: 200 {"briefs":[],"next_cursor":null}
      list, empty repo: 200 {"briefs":[{"id":7,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront and admin app","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"admin added","closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list, blank repo: 200 {"briefs":[{"id":7,"memoryId":"<mem>","tenantId":"default","repo":"acme/api","summary":"# Project Brief: acme/api\\n\\n_Auto-assembled from 0 receipt(s)._\\n\\n## Recent receipts\\n\\n_No receipts found for acme/api._","version":3,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"auto-refresh from 0 receipt(s)","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront and admin app","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"admin added","closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}"
    `);
  });
});
