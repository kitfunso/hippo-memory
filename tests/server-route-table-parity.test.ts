// Pins the status, headers and body shape of every HTTP route so a change to how requests are dispatched cannot change a reply.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject { [key: string]: Json }
type Outline = string | Outline[] | { [key: string]: Outline };

interface Reply {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  error?: string;
  code?: string;
  body: Outline;
}

interface Call {
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

const BAD_BEARER = { authorization: 'Bearer not-a-real-key' };

function normalise(text: string): string {
  return text.replace(/mem_[0-9a-f]+/g, 'mem_<id>');
}

function isText(v: Json | undefined): v is string {
  return typeof v === 'string';
}

function isCount(v: Json | undefined): v is number {
  return typeof v === 'number';
}

function isJsonObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && !Array.isArray(v) && !isText(v) && !isCount(v) && v !== true && v !== false;
}

function outlineOf(v: Json): Outline {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [outlineOf(v[0]!)];
  if (isJsonObject(v)) {
    const out: { [key: string]: Outline } = {};
    for (const [k, val] of Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) out[k] = outlineOf(val);
    return out;
  }
  if (isText(v)) return 'string';
  if (isCount(v)) return 'number';
  return 'boolean';
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

async function send(base: string, c: Call): Promise<{ reply: Reply; json: Json }> {
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
    body: outlineOf(json),
  };
  if (isJsonObject(json) && isText(json.error)) reply.error = normalise(json.error);
  if (isJsonObject(json) && isText(json.code)) reply.code = json.code;
  return { reply, json };
}

// One entry per /v1 route, in handleRequest's dispatch order. `:n` is a numeric id, `:m` a memory id.
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/v1/memories'],
  ['GET', '/v1/graph'],
  ['GET', '/v1/memories'],
  ['GET', '/v1/sessions/sess-1/assemble'],
  ['GET', '/v1/recall/drill/:m'],
  ['POST', '/v1/memories/:m/archive'],
  ['POST', '/v1/memories/:m/supersede'],
  ['POST', '/v1/memories/:m/promote'],
  ['DELETE', '/v1/memories/:m'],
  ['POST', '/v1/outcome'],
  ['GET', '/v1/context'],
  ['POST', '/v1/sleep'],
  ['POST', '/v1/auth/keys'],
  ['GET', '/v1/auth/keys'],
  ['DELETE', '/v1/auth/keys/hk_missing'],
  ['GET', '/v1/quarantine'],
  ['POST', '/v1/quarantine/:m/approve'],
  ['POST', '/v1/quarantine/:m/reject'],
  ['GET', '/v1/audit'],
  ['POST', '/v1/predictions'],
  ['GET', '/v1/predictions'],
  ['GET', '/v1/predictions/stats'],
  ['GET', '/v1/predictions/:n'],
  ['POST', '/v1/predictions/:n/close'],
  ['POST', '/v1/decisions'],
  ['GET', '/v1/decisions'],
  ['POST', '/v1/decisions/:n/supersede'],
  ['POST', '/v1/decisions/:n/close'],
  ['GET', '/v1/decisions/:n'],
  ['POST', '/v1/incidents'],
  ['GET', '/v1/incidents'],
  ['POST', '/v1/incidents/:n/resolve'],
  ['POST', '/v1/incidents/:n/close'],
  ['GET', '/v1/incidents/:n'],
  ['POST', '/v1/processes'],
  ['GET', '/v1/processes'],
  ['POST', '/v1/processes/:n/supersede'],
  ['POST', '/v1/processes/:n/close'],
  ['GET', '/v1/processes/:n'],
  ['POST', '/v1/policies'],
  ['GET', '/v1/policies'],
  ['GET', '/v1/policies/asof'],
  ['POST', '/v1/policies/:n/supersede'],
  ['POST', '/v1/policies/:n/close'],
  ['GET', '/v1/policies/:n'],
  ['POST', '/v1/skills'],
  ['GET', '/v1/skills'],
  ['GET', '/v1/skills/export'],
  ['POST', '/v1/skills/:n/supersede'],
  ['POST', '/v1/skills/:n/close'],
  ['GET', '/v1/skills/:n'],
  ['POST', '/v1/project-briefs'],
  ['GET', '/v1/project-briefs'],
  ['POST', '/v1/project-briefs/refresh'],
  ['POST', '/v1/project-briefs/:n/supersede'],
  ['POST', '/v1/project-briefs/:n/close'],
  ['GET', '/v1/project-briefs/:n'],
  ['POST', '/v1/customer-notes'],
  ['GET', '/v1/customer-notes'],
  ['POST', '/v1/customer-notes/:n/supersede'],
  ['POST', '/v1/customer-notes/:n/close'],
  ['GET', '/v1/customer-notes/:n'],
];

describe('HTTP route parity: status, headers and body shape per route', () => {
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

  const call = async (c: Call): Promise<Reply> => (await send(handle.url, c)).reply;
  const create = async (kind: string, path: string, body: JsonObject): Promise<Reply> => {
    const { reply, json } = await send(handle.url, { method: 'POST', path, body: JSON.stringify(body) });
    const inner = isJsonObject(json) ? Object.values(json)[0] : undefined;
    if (isJsonObject(inner) && isCount(inner.id)) created[kind] = inner.id;
    return reply;
  };
  const fill = (path: string): string => path.replace(':m', 'mem_parity_missing').replace(':n', '999999');

  for (const [method, path] of ROUTES) {
    it(`${method} ${path} with a bad bearer and an empty body`, async () => {
      expect(await call({ method, path: fill(path), headers: BAD_BEARER })).toMatchSnapshot();
    });
  }

  for (const [method, path] of ROUTES) {
    it(`${method} ${path} with no body on loopback`, async () => {
      expect(await call({ method, path: fill(path) })).toMatchSnapshot();
    });
  }

  it('memory routes with valid input', async () => {
    const out = {
      create: await call({ method: 'POST', path: '/v1/memories', body: JSON.stringify({ content: 'parity http create', kind: 'distilled', tags: ['a'] }) }),
      graph: await call({ method: 'GET', path: '/v1/graph?limit=5' }),
      recall: await call({ method: 'GET', path: '/v1/memories?q=zebra-route&limit=5&include_continuity=1' }),
      recallBadMode: await call({ method: 'GET', path: '/v1/memories?q=x&mode=nope' }),
      assemble: await call({ method: 'GET', path: '/v1/sessions/sess-1/assemble?budget=500' }),
      drill: await call({ method: 'GET', path: `/v1/recall/drill/${seeded.recall}` }),
      archive: await call({ method: 'POST', path: `/v1/memories/${seeded.raw}/archive`, body: JSON.stringify({ reason: 'parity' }) }),
      supersede: await call({ method: 'POST', path: `/v1/memories/${seeded.sup}/supersede`, body: JSON.stringify({ content: 'parity superseded text' }) }),
      promote: await call({ method: 'POST', path: `/v1/memories/${seeded.promo}/promote` }),
      forget: await call({ method: 'DELETE', path: `/v1/memories/${seeded.del}` }),
      outcome: await call({ method: 'POST', path: '/v1/outcome', body: JSON.stringify({ ids: [seeded.recall], good: true }) }),
      outcomeLast: await call({ method: 'POST', path: '/v1/outcome', body: JSON.stringify({ good: false }) }),
      context: await call({ method: 'GET', path: '/v1/context?q=zebra-route&budget=500' }),
      sleep: await call({ method: 'POST', path: '/v1/sleep', body: JSON.stringify({ dry_run: true, no_share: true }) }),
    };
    expect(out).toMatchSnapshot();
  });

  it('auth, quarantine and audit routes with valid input', async () => {
    const { reply: mint, json } = await send(handle.url, {
      method: 'POST', path: '/v1/auth/keys', body: JSON.stringify({ label: 'parity', role: 'member' }),
    });
    const keyId = isJsonObject(json) && isText(json.keyId) ? json.keyId : 'hk_missing';
    const out = {
      mint,
      list: await call({ method: 'GET', path: '/v1/auth/keys?active=false' }),
      listBad: await call({ method: 'GET', path: '/v1/auth/keys?active=maybe' }),
      revoke: await call({ method: 'DELETE', path: `/v1/auth/keys/${keyId}` }),
      quarantine: await call({ method: 'GET', path: '/v1/quarantine?status=all' }),
      approve: await call({ method: 'POST', path: `/v1/quarantine/${seeded.recall}/approve` }),
      reject: await call({ method: 'POST', path: `/v1/quarantine/${seeded.recall}/reject` }),
      audit: await call({ method: 'GET', path: '/v1/audit?limit=5' }),
      auditBadOp: await call({ method: 'GET', path: '/v1/audit?op=nope' }),
    };
    expect(out).toMatchSnapshot();
  });

  it('prediction and decision routes with valid input', async () => {
    const out = {
      predict: await create('prediction', '/v1/predictions', { claim: 'ship by friday', classTag: 'ship', estimate: 3, unit: 'days' }),
      predictions: await call({ method: 'GET', path: '/v1/predictions?class=ship' }),
      stats: await call({ method: 'GET', path: '/v1/predictions/stats?class=ship' }),
      prediction: await call({ method: 'GET', path: `/v1/predictions/${created.prediction}` }),
      closePrediction: await call({ method: 'POST', path: `/v1/predictions/${created.prediction}/close`, body: JSON.stringify({ state: 'closed', actual: 4 }) }),
      decide: await create('decision', '/v1/decisions', { text: 'use sqlite', context: 'parity' }),
      decisions: await call({ method: 'GET', path: '/v1/decisions?status=active' }),
      decision: await call({ method: 'GET', path: `/v1/decisions/${created.decision}` }),
      supersedeDecision: await call({ method: 'POST', path: `/v1/decisions/${created.decision}/supersede`, body: JSON.stringify({ text: 'use postgres' }) }),
      closeDecision: await call({ method: 'POST', path: `/v1/decisions/${created.decision}/close` }),
    };
    expect(out).toMatchSnapshot();
  });

  it('incident and process routes with valid input', async () => {
    const out = {
      open: await create('incident', '/v1/incidents', { text: 'db down', linkedMemoryIds: [seeded.recall] }),
      incidents: await call({ method: 'GET', path: '/v1/incidents?status=open' }),
      incident: await call({ method: 'GET', path: `/v1/incidents/${created.incident}` }),
      resolve: await call({ method: 'POST', path: `/v1/incidents/${created.incident}/resolve`, body: JSON.stringify({ resolutionText: 'restarted' }) }),
      closeIncident: await call({ method: 'POST', path: `/v1/incidents/${created.incident}/close` }),
      process: await create('process', '/v1/processes', { processName: 'deploy', steps: ['build', 'ship'], description: 'parity' }),
      processes: await call({ method: 'GET', path: '/v1/processes?status=active' }),
      processById: await call({ method: 'GET', path: `/v1/processes/${created.process}` }),
      supersedeProcess: await call({ method: 'POST', path: `/v1/processes/${created.process}/supersede`, body: JSON.stringify({ steps: ['build', 'test', 'ship'], changeSummary: 'add test' }) }),
      closeProcess: await call({ method: 'POST', path: `/v1/processes/${created.process}/close` }),
    };
    expect(out).toMatchSnapshot();
  });

  it('policy and skill routes with valid input', async () => {
    const out = {
      policy: await create('policy', '/v1/policies', { policyName: 'retention', policyText: 'keep 30 days', validFrom: '2026-01-01' }),
      policies: await call({ method: 'GET', path: '/v1/policies?status=active' }),
      asof: await call({ method: 'GET', path: '/v1/policies/asof?date=2026-06-01' }),
      policyById: await call({ method: 'GET', path: `/v1/policies/${created.policy}` }),
      supersedePolicy: await call({ method: 'POST', path: `/v1/policies/${created.policy}/supersede`, body: JSON.stringify({ policyText: 'keep 60 days' }) }),
      closePolicy: await call({ method: 'POST', path: `/v1/policies/${created.policy}/close` }),
      skill: await create('skill', '/v1/skills', { skillName: 'triage', instructions: 'read logs first', trigger: 'on page' }),
      skills: await call({ method: 'GET', path: '/v1/skills?status=active' }),
      exportSkills: await call({ method: 'GET', path: '/v1/skills/export' }),
      skillById: await call({ method: 'GET', path: `/v1/skills/${created.skill}` }),
      supersedeSkill: await call({ method: 'POST', path: `/v1/skills/${created.skill}/supersede`, body: JSON.stringify({ instructions: 'read logs, then metrics' }) }),
      closeSkill: await call({ method: 'POST', path: `/v1/skills/${created.skill}/close` }),
    };
    expect(out).toMatchSnapshot();
  });

  it('project brief and customer note routes with valid input', async () => {
    const out = {
      brief: await create('brief', '/v1/project-briefs', { repo: 'kitfunso/parity', summary: 'parity brief' }),
      briefs: await call({ method: 'GET', path: '/v1/project-briefs?repo=kitfunso/parity' }),
      refresh: await call({ method: 'POST', path: '/v1/project-briefs/refresh', body: JSON.stringify({ repo: 'kitfunso/parity', dryRun: true }) }),
      briefById: await call({ method: 'GET', path: `/v1/project-briefs/${created.brief}` }),
      supersedeBrief: await call({ method: 'POST', path: `/v1/project-briefs/${created.brief}/supersede`, body: JSON.stringify({ summary: 'parity brief v2' }) }),
      closeBrief: await call({ method: 'POST', path: `/v1/project-briefs/${created.brief}/close` }),
      note: await create('note', '/v1/customer-notes', { customer: 'acme', note: 'likes sqlite' }),
      notes: await call({ method: 'GET', path: '/v1/customer-notes?customer=acme' }),
      noteById: await call({ method: 'GET', path: `/v1/customer-notes/${created.note}` }),
      supersedeNote: await call({ method: 'POST', path: `/v1/customer-notes/${created.note}/supersede`, body: JSON.stringify({ note: 'likes postgres' }) }),
      closeNote: await call({ method: 'POST', path: `/v1/customer-notes/${created.note}/close` }),
    };
    expect(out).toMatchSnapshot();
  });

  it('a literal path segment wins over the parameterised route next to it', async () => {
    const out = {
      statsNotById: await call({ method: 'GET', path: '/v1/predictions/stats' }),
      asofNotById: await call({ method: 'GET', path: '/v1/policies/asof' }),
      exportNotById: await call({ method: 'GET', path: '/v1/skills/export' }),
      refreshNotById: await call({ method: 'POST', path: '/v1/project-briefs/refresh' }),
      archiveNotDelete: await call({ method: 'DELETE', path: '/v1/memories/mem_x/archive' }),
      keyIdNotList: await call({ method: 'GET', path: '/v1/auth/keys/hk_x' }),
    };
    expect(out).toMatchSnapshot();
  });

  it('non-routes, wrong methods and malformed paths', async () => {
    const out = {
      health: await call({ method: 'GET', path: '/health' }),
      healthPost: await call({ method: 'POST', path: '/health' }),
      wrongMethodExact: await call({ method: 'PUT', path: '/v1/memories' }),
      wrongMethodParam: await call({ method: 'GET', path: '/v1/memories/mem_x' }),
      wrongMethodRegex: await call({ method: 'DELETE', path: '/v1/predictions/1' }),
      nonNumericRegexId: await call({ method: 'GET', path: '/v1/decisions/abc' }),
      unknownV1: await call({ method: 'GET', path: '/v1/nope' }),
      unknownRoot: await call({ method: 'GET', path: '/nope' }),
      encodedSlash: await call({ method: 'GET', path: '/v1/memories/a%2Fb' }),
      encodedSlashUnknown: await call({ method: 'GET', path: '/nope%2f' }),
      malformedPercentWrongMethod: await call({ method: 'GET', path: '/v1/memories/%E0%A4%A' }),
      malformedPercentDeep: await call({ method: 'PUT', path: '/v1/sessions/%E0%A4%A/assemble' }),
      badId: await call({ method: 'DELETE', path: '/v1/memories/bad!id' }),
      slackNoSecret: await call({ method: 'POST', path: '/v1/connectors/slack/events', body: '{}' }),
      githubNoSecret: await call({ method: 'POST', path: '/v1/connectors/github/events', body: '{}' }),
      slackWrongMethod: await call({ method: 'GET', path: '/v1/connectors/slack/events' }),
      mcpBadJson: await call({ method: 'POST', path: '/mcp', body: 'not json' }),
      mcpWrongMethod: await call({ method: 'GET', path: '/mcp' }),
      invalidJson: await call({ method: 'POST', path: '/v1/memories', body: '{bad' }),
      arrayBody: await call({ method: 'POST', path: '/v1/memories', body: '[]' }),
    };
    expect(out).toMatchSnapshot();
  });
});

describe('HTTP route parity under the rate limiter', () => {
  it('throttles /v1 and /mcp but never /health or other paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-route-parity-rl-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    const saved = process.env.HIPPO_V1_RPS;
    process.env.HIPPO_V1_RPS = '0.5';
    const handle = await serve({ hippoRoot: home, port: 0 });
    try {
      const call = async (c: Call): Promise<Reply> => (await send(handle.url, c)).reply;
      const out = {
        first: await call({ method: 'GET', path: '/v1/nope' }),
        second: await call({ method: 'GET', path: '/v1/nope' }),
        throttledRoute: await call({ method: 'GET', path: '/v1/decisions' }),
        throttledMcp: await call({ method: 'POST', path: '/mcp', body: '{}' }),
        health: await call({ method: 'GET', path: '/health' }),
        otherPath: await call({ method: 'GET', path: '/nope' }),
        encodedSlashBeforeLimiter: await call({ method: 'GET', path: '/v1/a%2Fb' }),
      };
      expect(out).toMatchSnapshot();
    } finally {
      await handle.stop();
      if (saved === undefined) delete process.env.HIPPO_V1_RPS;
      else process.env.HIPPO_V1_RPS = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
