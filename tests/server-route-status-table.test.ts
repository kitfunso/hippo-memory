// Pins the status and error text of every HTTP route, plus one literal field per route's valid reply, so a dispatch change cannot move a reply.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject { [key: string]: Json }

interface Reply {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  error?: string;
  json: Json;
}

interface Call {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

const BAD_BEARER = { authorization: 'Bearer not-a-real-key' };

function isText(v: Json | undefined): v is string {
  return typeof v === 'string';
}

function isCount(v: Json | undefined): v is number {
  return typeof v === 'number';
}

function isJsonObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && !Array.isArray(v) && !isText(v) && !isCount(v) && v !== true && v !== false;
}

function parseReply(text: string): Json {
  if (text.length === 0) return '';
  try {
    const parsed: Json = JSON.parse(text);
    return parsed;
  } catch {
    return `<non-json:${text.length}>`;
  }
}

async function send(base: string, c: Call): Promise<Reply> {
  const res = await fetch(`${base}${c.path}`, {
    method: c.method,
    headers: { 'content-type': 'application/json', ...c.headers },
    body: c.body,
  });
  const json = parseReply(await res.text());
  const reply: Reply = {
    status: res.status,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    json,
  };
  if (isJsonObject(json) && isText(json.error)) reply.error = json.error;
  return reply;
}

// Literal status and error text per /v1 route, in handleRequest's dispatch order: [method, path, bad bearer, no body on loopback].
// `:n` is a numeric id, `:m` a memory id; a 200 row has no error text.
type Outcome = readonly [status: number, error?: string];
const ROUTES: ReadonlyArray<readonly [string, string, Outcome, Outcome]> = [
  ['POST', '/v1/memories', [401, 'invalid api key'], [400, 'content is required']],
  ['GET', '/v1/graph', [401, 'invalid api key'], [200]],
  ['GET', '/v1/memories', [400, 'q is required'], [400, 'q is required']],
  ['GET', '/v1/sessions/sess-1/assemble', [401, 'invalid api key'], [200]],
  ['GET', '/v1/recall/drill/:m', [401, 'invalid api key'], [404, 'No drillable summary at this id']],
  ['POST', '/v1/memories/:m/archive', [401, 'invalid api key'], [400, 'reason is required']],
  ['POST', '/v1/memories/:m/supersede', [401, 'invalid api key'], [400, 'content is required']],
  ['POST', '/v1/memories/:m/promote', [401, 'invalid api key'], [404, 'memory not found: mem_parity_missing']],
  ['DELETE', '/v1/memories/:m', [401, 'invalid api key'], [404, 'memory not found: mem_parity_missing']],
  ['POST', '/v1/outcome', [401, 'invalid api key'], [400, 'good is required (boolean)']],
  ['GET', '/v1/context', [401, 'invalid api key'], [200]],
  ['POST', '/v1/sleep', [401, 'invalid api key'], [200]],
  ['POST', '/v1/auth/keys', [401, 'invalid api key'], [200]],
  ['GET', '/v1/auth/keys', [401, 'invalid api key'], [200]],
  ['DELETE', '/v1/auth/keys/hk_missing', [401, 'invalid api key'], [404, 'Unknown key_id: hk_missing']],
  ['GET', '/v1/quarantine', [401, 'invalid api key'], [200]],
  ['POST', '/v1/quarantine/:m/approve', [401, 'invalid api key'], [404, 'not quarantined: mem_parity_missing']],
  ['POST', '/v1/quarantine/:m/reject', [401, 'invalid api key'], [404, 'not quarantined: mem_parity_missing']],
  ['GET', '/v1/audit', [401, 'invalid api key'], [200]],
  ['POST', '/v1/predictions', [401, 'invalid api key'], [400, 'claim is required (non-empty string)']],
  ['GET', '/v1/predictions', [401, 'invalid api key'], [200]],
  ['GET', '/v1/predictions/stats', [400, 'class param is required'], [400, 'class param is required']],
  ['GET', '/v1/predictions/:n', [401, 'invalid api key'], [404, 'prediction 999999 not found']],
  ['POST', '/v1/predictions/:n/close', [401, 'invalid api key'], [400, 'state is required and must be one of: closed | closed-unknown']],
  ['POST', '/v1/decisions', [401, 'invalid api key'], [400, 'text is required (non-empty string)']],
  ['GET', '/v1/decisions', [401, 'invalid api key'], [200]],
  ['POST', '/v1/decisions/:n/supersede', [401, 'invalid api key'], [400, 'text is required (non-empty string)']],
  ['POST', '/v1/decisions/:n/close', [401, 'invalid api key'], [404, 'closeDecision: decision 999999 not found for tenant default']],
  ['GET', '/v1/decisions/:n', [401, 'invalid api key'], [404, 'decision 999999 not found']],
  ['POST', '/v1/incidents', [401, 'invalid api key'], [400, 'text is required (non-empty string)']],
  ['GET', '/v1/incidents', [401, 'invalid api key'], [200]],
  ['POST', '/v1/incidents/:n/resolve', [401, 'invalid api key'], [400, 'resolutionText is required (non-empty string)']],
  ['POST', '/v1/incidents/:n/close', [401, 'invalid api key'], [404, 'closeIncident: incident 999999 not found for tenant default']],
  ['GET', '/v1/incidents/:n', [401, 'invalid api key'], [404, 'incident 999999 not found']],
  ['POST', '/v1/processes', [401, 'invalid api key'], [400, 'processName is required (non-empty string)']],
  ['GET', '/v1/processes', [401, 'invalid api key'], [200]],
  ['POST', '/v1/processes/:n/supersede', [401, 'invalid api key'], [400, 'steps is required (at least one step) for a supersession']],
  ['POST', '/v1/processes/:n/close', [401, 'invalid api key'], [404, 'closeProcess: process 999999 not found for tenant default']],
  ['GET', '/v1/processes/:n', [401, 'invalid api key'], [404, 'process 999999 not found']],
  ['POST', '/v1/policies', [401, 'invalid api key'], [400, 'policyName is required (non-empty string)']],
  ['GET', '/v1/policies', [401, 'invalid api key'], [200]],
  ['GET', '/v1/policies/asof', [400, 'date is required (ISO-8601 valid-time)'], [400, 'date is required (ISO-8601 valid-time)']],
  ['POST', '/v1/policies/:n/supersede', [401, 'invalid api key'], [400, 'policyText is required (non-empty string)']],
  ['POST', '/v1/policies/:n/close', [401, 'invalid api key'], [404, 'closePolicy: policy 999999 not found for tenant default']],
  ['GET', '/v1/policies/:n', [401, 'invalid api key'], [404, 'policy 999999 not found']],
  ['POST', '/v1/skills', [401, 'invalid api key'], [400, 'skillName is required (non-empty string)']],
  ['GET', '/v1/skills', [401, 'invalid api key'], [200]],
  ['GET', '/v1/skills/export', [401, 'invalid api key'], [200]],
  ['POST', '/v1/skills/:n/supersede', [401, 'invalid api key'], [400, 'instructions are required (non-empty string)']],
  ['POST', '/v1/skills/:n/close', [401, 'invalid api key'], [404, 'closeSkill: skill 999999 not found for tenant default']],
  ['GET', '/v1/skills/:n', [401, 'invalid api key'], [404, 'skill 999999 not found']],
  ['POST', '/v1/project-briefs', [401, 'invalid api key'], [400, 'repo is required (non-empty string)']],
  ['GET', '/v1/project-briefs', [401, 'invalid api key'], [200]],
  ['POST', '/v1/project-briefs/refresh', [401, 'invalid api key'], [400, 'repo is required (non-empty string)']],
  ['POST', '/v1/project-briefs/:n/supersede', [401, 'invalid api key'], [400, 'summary is required (non-empty string)']],
  ['POST', '/v1/project-briefs/:n/close', [401, 'invalid api key'], [404, 'closeProjectBrief: brief 999999 not found for tenant default']],
  ['GET', '/v1/project-briefs/:n', [401, 'invalid api key'], [404, 'project brief 999999 not found']],
  ['POST', '/v1/customer-notes', [401, 'invalid api key'], [400, 'customer is required (non-empty string)']],
  ['GET', '/v1/customer-notes', [401, 'invalid api key'], [200]],
  ['POST', '/v1/customer-notes/:n/supersede', [401, 'invalid api key'], [400, 'note is required (non-empty string)']],
  ['POST', '/v1/customer-notes/:n/close', [401, 'invalid api key'], [404, 'closeCustomerNote: note 999999 not found for tenant default']],
  ['GET', '/v1/customer-notes/:n', [401, 'invalid api key'], [404, 'customer note 999999 not found']],
];

// [name, method, path, body, status, error]
type Case = readonly [string, string, string, string | undefined, number, string?];
const NOT_FOUND = 'not found';
const SLASH = 'URL-encoded slash (%2F) not allowed in path segments';
const NON_ROUTES: ReadonlyArray<Case> = [
  ['health', 'GET', '/health', undefined, 200],
  ['healthPost', 'POST', '/health', undefined, 404, NOT_FOUND],
  ['wrongMethodExact', 'PUT', '/v1/memories', undefined, 404, NOT_FOUND],
  ['wrongMethodParam', 'GET', '/v1/memories/mem_x', undefined, 404, NOT_FOUND],
  ['wrongMethodRegex', 'DELETE', '/v1/predictions/1', undefined, 404, NOT_FOUND],
  ['nonNumericRegexId', 'GET', '/v1/decisions/abc', undefined, 404, NOT_FOUND],
  ['unknownV1', 'GET', '/v1/nope', undefined, 404, NOT_FOUND],
  ['unknownRoot', 'GET', '/nope', undefined, 404, NOT_FOUND],
  ['encodedSlash', 'GET', '/v1/memories/a%2Fb', undefined, 400, SLASH],
  ['encodedSlashUnknown', 'GET', '/nope%2f', undefined, 400, SLASH],
  ['malformedPercentWrongMethod', 'GET', '/v1/memories/%E0%A4%A', undefined, 400, 'URI malformed'],
  ['malformedPercentDeep', 'PUT', '/v1/sessions/%E0%A4%A/assemble', undefined, 400, 'URI malformed'],
  ['badId', 'DELETE', '/v1/memories/bad!id', undefined, 400, 'memory id contains invalid characters; allowed: A-Z a-z 0-9 _ : . -'],
  ['slackNoSecret', 'POST', '/v1/connectors/slack/events', '{}', 404, NOT_FOUND],
  ['githubNoSecret', 'POST', '/v1/connectors/github/events', '{}', 404, NOT_FOUND],
  ['slackWrongMethod', 'GET', '/v1/connectors/slack/events', undefined, 404, NOT_FOUND],
  ['mcpBadJson', 'POST', '/mcp', 'not json', 400, 'invalid JSON-RPC body'],
  ['mcpWrongMethod', 'GET', '/mcp', undefined, 404, NOT_FOUND],
  ['invalidJson', 'POST', '/v1/memories', '{bad', 400, 'invalid JSON body'],
  ['arrayBody', 'POST', '/v1/memories', '[]', 400, 'request body must be a JSON object'],
];

const LIMITED: ReadonlyArray<Case> = [
  ['first', 'GET', '/v1/nope', undefined, 404, NOT_FOUND],
  ['second', 'GET', '/v1/nope', undefined, 429, 'rate limit exceeded'],
  ['throttledRoute', 'GET', '/v1/decisions', undefined, 429, 'rate limit exceeded'],
  ['throttledMcp', 'POST', '/mcp', '{}', 429, 'rate limit exceeded'],
  ['health', 'GET', '/health', undefined, 200],
  ['otherPath', 'GET', '/nope', undefined, 404, NOT_FOUND],
  ['encodedSlashBeforeLimiter', 'GET', '/v1/a%2Fb', undefined, 400, SLASH],
];

async function runCases(base: string, cases: ReadonlyArray<Case>): Promise<unknown[]> {
  const got: unknown[] = [];
  for (const [name, method, path, body] of cases) {
    const r = await send(base, { method, path, body });
    got.push([name, r.status, r.error]);
  }
  return got;
}

const expected = (cases: ReadonlyArray<Case>): unknown[] => cases.map(([name, , , , status, error]) => [name, status, error]);

describe('HTTP route status table: status and error text per route', () => {
  let home: string;
  let handle: ServerHandle;
  let globalHome: string;
  let savedRps: string | undefined;
  let savedHippoHome: string | undefined;
  const seeded: Record<string, string> = {};
  const created: Record<string, number> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'hippo-route-parity-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-route-parity-global-'));
    mkdirSync(join(globalHome, '.hippo'), { recursive: true });
    initStore(globalHome);
    savedHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    for (const [key, content, kind] of [
      ['raw', 'parity raw row for archive', 'raw'],
      ['sup', 'parity row to supersede', 'distilled'],
      ['promo', 'parity row to promote', 'distilled'],
      ['del', 'parity row to delete', 'distilled'],
      ['recall', 'parity recall needle zebra-route', 'distilled'],
    ] as const) {
      const entry = createMemory(content, { kind, baseHalfLifeDays: 30 });
      writeEntry(home, entry);
      seeded[key] = entry.id;
    }
    savedRps = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '0';
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    if (savedRps === undefined) delete process.env.HIPPO_V1_RPS;
    else process.env.HIPPO_V1_RPS = savedRps;
    if (savedHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = savedHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  const call = (c: Call): Promise<Reply> => send(handle.url, c);
  const create = async (kind: string, path: string, body: JsonObject): Promise<Reply> => {
    const reply = await call({ method: 'POST', path, body: JSON.stringify(body) });
    const inner = isJsonObject(reply.json) ? Object.values(reply.json)[0] : undefined;
    if (isJsonObject(inner) && isCount(inner.id)) created[kind] = inner.id;
    return reply;
  };
  const fill = (path: string): string => path.replace(':m', 'mem_parity_missing').replace(':n', '999999');
  const post = (path: string, body?: JsonObject): Promise<Reply> =>
    call({ method: 'POST', path, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string): Promise<Reply> => call({ method: 'GET', path });
  const shows = (r: Reply, status: number, json: unknown): void => {
    expect(r).toMatchObject({ status, json });
  };

  for (const [method, path, [status, error]] of ROUTES) {
    it(`${method} ${path} with a bad bearer and an empty body`, async () => {
      const r = await call({ method, path: fill(path), headers: BAD_BEARER });
      expect({ status: r.status, error: r.error, contentType: r.contentType }).toEqual({ status, error, contentType: 'application/json' });
    });
  }

  for (const [method, path, , [status, error]] of ROUTES) {
    it(`${method} ${path} with no body on loopback`, async () => {
      const r = await call({ method, path: fill(path) });
      expect({ status: r.status, error: r.error, contentType: r.contentType }).toEqual({ status, error, contentType: 'application/json' });
    });
  }

  it('memory routes with valid input', async () => {
    const out = {
      create: await post('/v1/memories', { content: 'parity http create', kind: 'distilled', tags: ['a'] }),
      graph: await get('/v1/graph?limit=5'),
      recall: await get('/v1/memories?q=zebra-route&limit=5&include_continuity=1'),
      recallBadMode: await get('/v1/memories?q=x&mode=nope'),
      assemble: await get('/v1/sessions/sess-1/assemble?budget=500'),
      drill: await get(`/v1/recall/drill/${seeded.recall}`),
      archive: await post(`/v1/memories/${seeded.raw}/archive`, { reason: 'parity' }),
      supersede: await post(`/v1/memories/${seeded.sup}/supersede`, { content: 'parity superseded text' }),
      promote: await post(`/v1/memories/${seeded.promo}/promote`),
      forget: await call({ method: 'DELETE', path: `/v1/memories/${seeded.del}` }),
      outcome: await post('/v1/outcome', { ids: [seeded.recall], good: true }),
      outcomeLast: await post('/v1/outcome', { good: false }),
      context: await get('/v1/context?q=zebra-route&budget=500'),
      sleep: await post('/v1/sleep', { dry_run: true, no_share: true }),
    };
    shows(out.create, 200, { kind: 'distilled', tenantId: 'default' });
    shows(out.graph, 200, { truncated: false });
    shows(out.recall, 200, { results: [{ content: 'parity recall needle zebra-route' }] });
    expect(out.recall.cacheControl).toBe('no-store');
    shows(out.recallBadMode, 400, { error: "mode must be 'bm25', 'hybrid', or 'physics'" });
    shows(out.assemble, 200, { sessionId: 'sess-1' });
    shows(out.drill, 422, { error: 'Id is a leaf row, not a level-2+ summary; nothing to drill into' });
    shows(out.archive, 200, { ok: true });
    shows(out.supersede, 200, { oldId: seeded.sup });
    shows(out.promote, 200, { sourceId: seeded.promo });
    shows(out.forget, 200, { id: seeded.del });
    shows(out.outcome, 200, { applied: 1 });
    shows(out.outcomeLast, 200, { applied: expect.any(Number) });
    shows(out.context, 200, { entries: [{ entry: { id: seeded.recall } }] });
    shows(out.sleep, 200, { dryRun: true });
  });

  it('auth, quarantine and audit routes with valid input', async () => {
    const mint = await post('/v1/auth/keys', { label: 'parity', role: 'member' });
    const keyId = isJsonObject(mint.json) && isText(mint.json.keyId) ? mint.json.keyId : 'hk_missing';
    const out = {
      list: await get('/v1/auth/keys?active=false'),
      listBad: await get('/v1/auth/keys?active=maybe'),
      revoke: await call({ method: 'DELETE', path: `/v1/auth/keys/${keyId}` }),
      quarantine: await get('/v1/quarantine?status=all'),
      approve: await post(`/v1/quarantine/${seeded.recall}/approve`),
      reject: await post(`/v1/quarantine/${seeded.recall}/reject`),
      audit: await get('/v1/audit?limit=5'),
      auditBadOp: await get('/v1/audit?op=nope'),
    };
    shows(mint, 200, { tenantId: 'default', role: 'member' });
    shows(out.list, 200, expect.arrayContaining([expect.objectContaining({ keyId, label: 'parity' })]));
    shows(out.listBad, 400, { error: "active must be 'true' or 'false'" });
    shows(out.revoke, 200, { ok: true });
    shows(out.quarantine, 200, { quarantine: [] });
    shows(out.approve, 404, { error: `not quarantined: ${seeded.recall}` });
    shows(out.reject, 404, { error: `not quarantined: ${seeded.recall}` });
    shows(out.audit, 200, expect.arrayContaining([expect.objectContaining({ op: 'auth_revoke', targetId: keyId })]));
    shows(out.auditBadOp, 400, { error: 'invalid op: nope' });
  });

  it('prediction and decision routes with valid input', async () => {
    const out = {
      predict: await create('prediction', '/v1/predictions', { claim: 'ship by friday', classTag: 'ship', estimate: 3, unit: 'days' }),
      predictions: await get('/v1/predictions?class=ship'),
      stats: await get('/v1/predictions/stats?class=ship'),
      prediction: await get(`/v1/predictions/${created.prediction}`),
      closePrediction: await post(`/v1/predictions/${created.prediction}/close`, { state: 'closed', actual: 4 }),
      decide: await create('decision', '/v1/decisions', { text: 'use sqlite', context: 'parity' }),
      decisions: await get('/v1/decisions?status=active'),
      decision: await get(`/v1/decisions/${created.decision}`),
      supersedeDecision: await post(`/v1/decisions/${created.decision}/supersede`, { text: 'use postgres' }),
      closeDecision: await post(`/v1/decisions/${created.decision}/close`),
    };
    shows(out.predict, 201, { prediction: { claimText: 'ship by friday' } });
    shows(out.predictions, 200, { predictions: [{ classTag: 'ship' }] });
    shows(out.stats, 200, { baserate: { classTag: 'ship' } });
    shows(out.prediction, 200, { prediction: { estimateValue: 3 } });
    shows(out.closePrediction, 200, { prediction: { actualValue: 4 } });
    shows(out.decide, 201, { decision: { decisionText: 'use sqlite' } });
    shows(out.decisions, 200, { decisions: [{ context: 'parity' }] });
    shows(out.decision, 200, { decision: { status: 'active' } });
    shows(out.supersedeDecision, 201, { decision: { decisionText: 'use postgres' } });
    shows(out.closeDecision, 409, { error: "closeDecision: decision 1 is not active (status='superseded'); only active decisions can be closed." });
  });

  it('incident and process routes with valid input', async () => {
    const out = {
      open: await create('incident', '/v1/incidents', { text: 'db down', linkedMemoryIds: [seeded.recall] }),
      incidents: await get('/v1/incidents?status=open'),
      incident: await get(`/v1/incidents/${created.incident}`),
      resolve: await post(`/v1/incidents/${created.incident}/resolve`, { resolutionText: 'restarted' }),
      closeIncident: await post(`/v1/incidents/${created.incident}/close`),
      process: await create('process', '/v1/processes', { processName: 'deploy', steps: ['build', 'ship'], description: 'parity' }),
      processes: await get('/v1/processes?status=active'),
      processById: await get(`/v1/processes/${created.process}`),
      supersedeProcess: await post(`/v1/processes/${created.process}/supersede`, { steps: ['build', 'test', 'ship'], changeSummary: 'add test' }),
      closeProcess: await post(`/v1/processes/${created.process}/close`),
    };
    shows(out.open, 201, { incident: { incidentText: 'db down' } });
    shows(out.incidents, 200, { incidents: [{ status: 'open' }] });
    shows(out.incident, 200, { incident: { linkedMemoryIds: [seeded.recall] } });
    shows(out.resolve, 200, { incident: { resolutionText: 'restarted' } });
    shows(out.closeIncident, 200, { incident: { status: 'closed' } });
    shows(out.process, 201, { process: { processName: 'deploy' } });
    shows(out.processes, 200, { processes: [{ steps: ['build', 'ship'] }] });
    shows(out.processById, 200, { process: { description: 'parity' } });
    shows(out.supersedeProcess, 200, { process: { version: 2 } });
    shows(out.closeProcess, 409, { error: "closeProcess: process 1 is not active (status='superseded'); only active processes can be closed." });
  });

  it('policy and skill routes with valid input', async () => {
    const out = {
      policy: await create('policy', '/v1/policies', { policyName: 'retention', policyText: 'keep 30 days', validFrom: '2026-01-01' }),
      policies: await get('/v1/policies?status=active'),
      asof: await get('/v1/policies/asof?date=2026-06-01'),
      policyById: await get(`/v1/policies/${created.policy}`),
      supersedePolicy: await post(`/v1/policies/${created.policy}/supersede`, { policyText: 'keep 60 days' }),
      closePolicy: await post(`/v1/policies/${created.policy}/close`),
      skill: await create('skill', '/v1/skills', { skillName: 'triage', instructions: 'read logs first', trigger: 'on page' }),
      skills: await get('/v1/skills?status=active'),
      exportSkills: await get('/v1/skills/export'),
      skillById: await get(`/v1/skills/${created.skill}`),
      supersedeSkill: await post(`/v1/skills/${created.skill}/supersede`, { instructions: 'read logs, then metrics' }),
      closeSkill: await post(`/v1/skills/${created.skill}/close`),
    };
    shows(out.policy, 201, { policy: { policyText: 'keep 30 days' } });
    shows(out.policies, 200, { policies: [{ policyName: 'retention' }] });
    shows(out.asof, 200, { policies: [{ validFrom: '2026-01-01T00:00:00.000Z' }] });
    shows(out.policyById, 200, { policy: { version: 1 } });
    shows(out.supersedePolicy, 200, { policy: { policyText: 'keep 60 days' } });
    shows(out.closePolicy, 409, { error: "closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed." });
    shows(out.skill, 201, { skill: { skillName: 'triage' } });
    shows(out.skills, 200, { skills: [{ trigger: 'on page' }] });
    shows(out.exportSkills, 200, { markdown: '## triage\n\n**When:** on page\n\nread logs first' });
    shows(out.skillById, 200, { skill: { instructions: 'read logs first' } });
    shows(out.supersedeSkill, 200, { skill: { instructions: 'read logs, then metrics' } });
    shows(out.closeSkill, 409, { error: "closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed." });
  });

  it('project brief and customer note routes with valid input', async () => {
    const out = {
      brief: await create('brief', '/v1/project-briefs', { repo: 'kitfunso/parity', summary: 'parity brief' }),
      briefs: await get('/v1/project-briefs?repo=kitfunso/parity'),
      refresh: await post('/v1/project-briefs/refresh', { repo: 'kitfunso/parity', dryRun: true }),
      briefById: await get(`/v1/project-briefs/${created.brief}`),
      supersedeBrief: await post(`/v1/project-briefs/${created.brief}/supersede`, { summary: 'parity brief v2' }),
      closeBrief: await post(`/v1/project-briefs/${created.brief}/close`),
      note: await create('note', '/v1/customer-notes', { customer: 'acme', note: 'likes sqlite' }),
      notes: await get('/v1/customer-notes?customer=acme'),
      noteById: await get(`/v1/customer-notes/${created.note}`),
      supersedeNote: await post(`/v1/customer-notes/${created.note}/supersede`, { note: 'likes postgres' }),
      closeNote: await post(`/v1/customer-notes/${created.note}/close`),
    };
    shows(out.brief, 201, { brief: { summary: 'parity brief' } });
    shows(out.briefs, 200, { briefs: [{ repo: 'kitfunso/parity' }] });
    shows(out.refresh, 200, { receiptCount: 0 });
    shows(out.briefById, 200, { brief: { version: 1 } });
    shows(out.supersedeBrief, 200, { brief: { summary: 'parity brief v2' } });
    shows(out.closeBrief, 409, { error: "closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed." });
    shows(out.note, 201, { note: { note: 'likes sqlite' } });
    shows(out.notes, 200, { notes: [{ customer: 'acme' }] });
    shows(out.noteById, 200, { note: { status: 'active' } });
    shows(out.supersedeNote, 200, { note: { note: 'likes postgres' } });
    shows(out.closeNote, 409, { error: "closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed." });
  });

  it('a literal path segment wins over the parameterised route next to it', async () => {
    const out = {
      statsNotById: await get('/v1/predictions/stats'),
      asofNotById: await get('/v1/policies/asof'),
      exportNotById: await get('/v1/skills/export'),
      refreshNotById: await post('/v1/project-briefs/refresh'),
      archiveNotDelete: await call({ method: 'DELETE', path: '/v1/memories/mem_x/archive' }),
      keyIdNotList: await get('/v1/auth/keys/hk_x'),
    };
    shows(out.statsNotById, 400, { error: 'class param is required' });
    shows(out.asofNotById, 400, { error: 'date is required (ISO-8601 valid-time)' });
    shows(out.exportNotById, 200, { markdown: '## triage\n\nread logs, then metrics' });
    shows(out.refreshNotById, 400, { error: 'repo is required (non-empty string)' });
    shows(out.archiveNotDelete, 404, { error: NOT_FOUND });
    shows(out.keyIdNotList, 404, { error: NOT_FOUND });
  });

  it('non-routes, wrong methods and malformed paths', async () => {
    expect(await runCases(handle.url, NON_ROUTES)).toEqual(expected(NON_ROUTES));
  });
});

describe('HTTP route status table under the rate limiter', () => {
  it('throttles /v1 and /mcp but never /health or other paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-route-parity-rl-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    const saved = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '0.5';
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      expect(await runCases(handle.url, LIMITED)).toEqual(expected(LIMITED));
    } finally {
      await handle.stop();
      if (saved === undefined) delete process.env.HIPPO_V1_RPS;
      else process.env.HIPPO_V1_RPS = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
