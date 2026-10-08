// Pins each typed-object list route and which checks run before the caller is known, so a shared handler keeps the order.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ObjectApi, routeOf, type Body, type Caller, type Reply, type RouteSpec } from './_helpers/typed-object-http.js';
import { Transcript } from './_helpers/typed-object-specs.js';

let api: ObjectApi;
beforeAll(async () => {
  api = await ObjectApi.start('a8lists');
});
afterAll(async () => {
  await api.stop();
});

type Say = (label: string, method: string, path: string, body?: Body, caller?: Caller) => Promise<Reply>;

const cursorOf = (reply: Reply): string => /"next_cursor":"([^"]+)"/.exec(reply.text)?.[1] ?? '(no cursor)';
/** A well-formed cursor whose two parts have the wrong types. */
const SWAPPED_CURSOR = Buffer.from(JSON.stringify([1, 'x'])).toString('base64url');

/** A page as its row ids and whether a cursor came back; the first list of each type pins the full body. */
function pageLine(reply: Reply): string {
  if (reply.status !== 200) return reply.line;
  const ids = [...reply.text.matchAll(/\{"id":(\d+),/g)].map((m) => m[1]).join(',') || '(none)';
  return `200 ids ${ids} next_cursor ${reply.text.includes('"next_cursor":null') ? 'null' : 'set'}`;
}

/** Rows: 1 default (superseded by 5 where the type allows), 2 the other tenant, 3 default and closed, 4 default. */
async function seed(spec: RouteSpec): Promise<string> {
  const p = spec.path;
  const replies = [
    await api.send('POST', p, spec.create),
    await api.send('POST', p, spec.create, 'tenant-b'),
    await api.send('POST', p, spec.create),
    await api.send('POST', p, spec.create),
    await api.send('POST', `${p}/3/close`),
  ];
  if (spec.revise) replies.push(await api.send('POST', `${p}/1/supersede`, spec.revise));
  return replies.map((r) => r.status).join(' ');
}

async function listSteps(spec: RouteSpec, say: Say, page: Say): Promise<void> {
  const p = spec.path;
  await say('list', 'GET', p);
  await page('list as the other tenant', 'GET', p, undefined, 'tenant-b');
  await page('list with no key on loopback', 'GET', p, undefined, 'nobody');
  for (const status of ['all', 'active', 'superseded', 'closed', 'open', 'resolved', 'bogus', '', 'ALL', 'Active']) {
    await page(`list, status=${JSON.stringify(status)}`, 'GET', `${p}?status=${status}`);
  }
  const first = await page('list, limit=1', 'GET', `${p}?limit=1`);
  const second = await page('list, the page after it', 'GET', `${p}?limit=1&cursor=${cursorOf(first)}`);
  await page('list, the rest', 'GET', `${p}?limit=1000&cursor=${cursorOf(second)}`);
  await page('list, a cursor and a status', 'GET', `${p}?status=closed&cursor=${cursorOf(first)}`);
  for (const limit of ['0', '-1', '1.5', 'abc', '1001', '', '1e2', '%201%20']) {
    await page(`list, limit=${JSON.stringify(limit)}`, 'GET', `${p}?limit=${limit}`);
  }
  for (const cursor of ['junk', '!!', '', SWAPPED_CURSOR]) {
    const label = cursor === SWAPPED_CURSOR ? 'with swapped part types' : JSON.stringify(cursor);
    await page(`list, cursor ${label}`, 'GET', `${p}?cursor=${cursor}`);
  }
  await page('list, bad limit and unknown status', 'GET', `${p}?limit=0&status=bogus`);
  await page('list, bad limit and bad cursor', 'GET', `${p}?cursor=junk&limit=0`);
  await page('list, bad cursor and unknown status', 'GET', `${p}?cursor=junk&status=bogus`);
}

/** With auth required and no key: what is checked before the caller is known answers 400, the rest 401. */
async function keylessSteps(spec: RouteSpec, say: Say): Promise<void> {
  const p = spec.path;
  vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
  try {
    await say('no key: list', 'GET', p, undefined, 'nobody');
    await say('no key: list, bad limit', 'GET', `${p}?limit=0`, undefined, 'nobody');
    await say('no key: list, bad cursor', 'GET', `${p}?cursor=junk`, undefined, 'nobody');
    await say('no key: list, unknown status', 'GET', `${p}?status=bogus`, undefined, 'nobody');
    await say('no key: list, unknown status and bad limit', 'GET', `${p}?status=bogus&limit=0`, undefined, 'nobody');
    await say('no key: create', 'POST', p, spec.create, 'nobody');
    await say('no key: create, empty body', 'POST', p, {}, 'nobody');
    await say('no key: get', 'GET', `${p}/1`, undefined, 'nobody');
    await say('no key: get, missing id', 'GET', `${p}/9999`, undefined, 'nobody');
    await say('no key: close', 'POST', `${p}/4/close`, undefined, 'nobody');
    if (spec.revise) await say('no key: supersede, empty body', 'POST', `${p}/4/supersede`, {}, 'nobody');
    await say('with a key: list, bad limit', 'GET', `${p}?limit=0`);
    await say('with a key: list, unknown status', 'GET', `${p}?status=bogus`);
  } finally {
    vi.unstubAllEnvs();
  }
}

async function transcript(type: string): Promise<string> {
  const spec = routeOf(type);
  const t = new Transcript();
  const say: Say = async (label, method, path, body, caller) => {
    const reply = await api.send(method, path, body, caller);
    t.say(label, reply.line);
    return reply;
  };
  const page: Say = async (label, method, path, body, caller) => {
    const reply = await api.send(method, path, body, caller);
    t.say(label, pageLine(reply));
    return reply;
  };
  t.say('seed statuses', await seed(spec));
  await listSteps(spec, say, page);
  await keylessSteps(spec, say);
  await page('list after the keyless calls', 'GET', spec.path);
  return t.text();
}

describe('typed-object list routes and the order of their checks', () => {
  it('decision', async () => {
    expect(await transcript('decision')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 201
      list: 200 {"decisions":[{"id":5,"memoryId":"<mem>","tenantId":"default","decisionText":"Use SQLite for billing","context":"one file to back up","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"closed","supersededBy":null,"supersededAt":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"superseded","supersededBy":5,"supersededAt":"<ts>","closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });

  it('incident', async () => {
    expect(await transcript('incident')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200
      list: 200 {"incidents":[{"id":4,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"closed","resolutionText":null,"resolvedAt":null,"closedAt":"<ts>","linkedMemoryIds":[],"createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 4,3,1 next_cursor null
      list, status="all": 200 ids 4,3,1 next_cursor null
      list, status="active": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"active\\")"}
      list, status="superseded": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"superseded\\")"}
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 200 ids 4,1 next_cursor null
      list, status="resolved": 200 ids (none) next_cursor null
      list, status="bogus": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: open | resolved | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 4 next_cursor set
      list, the page after it: 200 ids 3 next_cursor set
      list, the rest: 200 ids 1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 4 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: open | resolved | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 4,3,1 next_cursor null"
    `);
  });

  it('process', async () => {
    expect(await transcript('process')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 200
      list: 200 {"processes":[{"id":5,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":null,"steps":["run the tests","sign and tag the build"],"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"sign the build","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"superseded","supersededBy":5,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });

  it('skill', async () => {
    expect(await transcript('skill')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 200
      list: 200 {"skills":[{"id":5,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check both paths","trigger":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"both ways","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"superseded","supersededBy":5,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });

  it('customer note', async () => {
    expect(await transcript('customer note')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 200
      list: 200 {"notes":[{"id":5,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers a call","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"asked on the phone","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"superseded","supersededBy":5,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });

  it('policy', async () => {
    expect(await transcript('policy')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 200
      list: 200 {"policies":[{"id":5,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 30 days","validFrom":"2026-06-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"shorter","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"superseded","supersededBy":5,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });

  it('project brief', async () => {
    expect(await transcript('project brief')).toMatchInlineSnapshot(`
      "seed statuses: 201 201 201 201 200 200
      list: 200 {"briefs":[{"id":5,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront and admin app","version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":"admin added","closedAt":null,"createdAt":"<ts>"},{"id":4,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"},{"id":3,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"closed","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":"<ts>","createdAt":"<ts>"},{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"superseded","supersededBy":5,"supersededAt":"<ts>","changeSummary":null,"closedAt":null,"createdAt":"<ts>"}],"next_cursor":null}
      list as the other tenant: 200 ids 2 next_cursor null
      list with no key on loopback: 200 ids 5,4,3,1 next_cursor null
      list, status="all": 200 ids 5,4,3,1 next_cursor null
      list, status="active": 200 ids 5,4 next_cursor null
      list, status="superseded": 200 ids 1 next_cursor null
      list, status="closed": 200 ids 3 next_cursor null
      list, status="open": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"open\\")"}
      list, status="resolved": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"resolved\\")"}
      list, status="bogus": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list, status="": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"\\")"}
      list, status="ALL": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"ALL\\")"}
      list, status="Active": 400 {"error":"status must be one of: active | superseded | closed | all (got \\"Active\\")"}
      list, limit=1: 200 ids 5 next_cursor set
      list, the page after it: 200 ids 4 next_cursor set
      list, the rest: 200 ids 3,1 next_cursor null
      list, a cursor and a status: 200 ids 3 next_cursor null
      list, limit="0": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="-1": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1.5": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="abc": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1001": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="": 400 {"error":"limit must be a positive integer <= 1000"}
      list, limit="1e2": 200 ids 5,4,3,1 next_cursor null
      list, limit="%201%20": 200 ids 5 next_cursor set
      list, cursor "junk": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "!!": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor "": 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, cursor with swapped part types: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      list, bad limit and unknown status: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad limit and bad cursor: 400 {"error":"limit must be a positive integer <= 1000"}
      list, bad cursor and unknown status: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list: 401 {"error":"auth required"}
      no key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: list, bad cursor: 400 {"error":"cursor is malformed; pass next_cursor from the previous page unchanged"}
      no key: list, unknown status: 401 {"error":"auth required"}
      no key: list, unknown status and bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      no key: create: 401 {"error":"auth required"}
      no key: create, empty body: 401 {"error":"auth required"}
      no key: get: 401 {"error":"auth required"}
      no key: get, missing id: 401 {"error":"auth required"}
      no key: close: 401 {"error":"auth required"}
      no key: supersede, empty body: 401 {"error":"auth required"}
      with a key: list, bad limit: 400 {"error":"limit must be a positive integer <= 1000"}
      with a key: list, unknown status: 400 {"error":"status must be one of: active | superseded | closed | all (got \\"bogus\\")"}
      list after the keyless calls: 200 ids 5,4,3,1 next_cursor null"
    `);
  });
});
