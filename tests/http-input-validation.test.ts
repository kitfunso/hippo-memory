// Every /v1 write route rejects a malformed body with a 400 that names the field, and writes nothing;
// supersede of a missing row is a 404 and a dangling reference a 409, against a real store over HTTP.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { JsonValue } from '../src/util/json.js';

let home: string;
let handle: ServerHandle;
let token: string;
const ids: Record<string, number> = {};

type Body = { [key: string]: JsonValue };

async function call(method: string, path: string, body?: Body, headers: Record<string, string> = {}) {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // SAFETY: every route answers JSON; a parse failure throws and fails the test.
  return { status: res.status, json: JSON.parse(text) as Body };
}

async function created(path: string, body: Body, key: string): Promise<number> {
  const r = await call('POST', path, body);
  expect(r.status).toBe(201);
  // SAFETY: each create route returns its row under `key`, and every row has a numeric id.
  return (r.json[key] as { id: number }).id;
}

const long = (n: number): string => 'x'.repeat(n + 1);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'hippo-http-validation-'));
  initStore(home);
  const db = openHippoDb(home);
  try {
    token = createApiKey(db, { tenantId: 'default', label: 'validation', role: 'admin' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
  // Seventy requests from one IP would trip the per-IP limiter; it is read once, at serve().
  vi.stubEnv('HIPPO_V1_RPS', '0');
  handle = await serve({ hippoRoot: home, port: 0 });
  vi.unstubAllEnvs();
  ids.decision = await created('/v1/decisions', { text: 'use sqlite for the store' }, 'decision');
  ids.process = await created('/v1/processes', { processName: 'release', steps: ['tag', 'publish'] }, 'process');
  ids.policy = await created('/v1/policies', { policyName: 'retention', policyText: 'keep 30 days' }, 'policy');
  ids.skill = await created('/v1/skills', { skillName: 'bisect', instructions: 'halve the range' }, 'skill');
  ids.brief = await created('/v1/project-briefs', { repo: 'acme/app', summary: 'a web app' }, 'brief');
  ids.note = await created('/v1/customer-notes', { customer: 'acme', note: 'prefers email' }, 'note');
  ids.prediction = await created('/v1/predictions', { claim: 'ships friday', classTag: 'release' }, 'prediction');
});

afterAll(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP input validation', () => {
  const bad: Array<[string, string, string, Body | undefined, RegExp]> = [
    ['memory kind', 'POST', '/v1/memories', { content: 'a fact', kind: 'opinion' }, /invalid kind: opinion/],
    ['outcome ids type', 'POST', '/v1/outcome', { good: true, ids: 'mem_1' }, /ids must be an array/],
    ['sleep no_share type', 'POST', '/v1/sleep', { no_share: 'yes' }, /no_share must be a boolean/],
    ['key label type', 'POST', '/v1/auth/keys', { label: 7 }, /label must be a string/],
    ['key role', 'POST', '/v1/auth/keys', { role: 'owner' }, /role must be 'admin' or 'member'/],
    ['prediction classTag', 'POST', '/v1/predictions', { claim: 'c', classTag: '' }, /classTag is required/],
    ['prediction estimate', 'POST', '/v1/predictions', { claim: 'c', classTag: 't', estimate: 'ten' }, /estimate must be a finite number/],
    ['prediction unit', 'POST', '/v1/predictions', { claim: 'c', classTag: 't', unit: 3 }, /unit must be a string/],
    ['prediction targetDate', 'POST', '/v1/predictions', { claim: 'c', classTag: 't', targetDate: 20260101 }, /targetDate must be an ISO date string/],
    ['prediction close actual', 'POST', '/v1/predictions/1/close', { state: 'closed', actual: 'n/a' }, /actual must be a finite number/],
    ['prediction close note type', 'POST', '/v1/predictions/1/close', { state: 'closed', note: 1 }, /note must be a string/],
    ['prediction close note cap', 'POST', '/v1/predictions/1/close', { state: 'closed', note: long(2048) }, /note exceeds 2048/],
    ['decision context type', 'POST', '/v1/decisions', { text: 't', context: 1 }, /context must be a string/],
    ['decision context cap', 'POST', '/v1/decisions', { text: 't', context: long(4096) }, /context exceeds 4096/],
    ['decision supersedes id', 'POST', '/v1/decisions', { text: 't', supersedesDecisionId: -2 }, /supersedesDecisionId must be a positive integer/],
    ['decision supersede text cap', 'POST', '/v1/decisions/1/supersede', { text: long(4096) }, /text exceeds 4096/],
    ['decision supersede context type', 'POST', '/v1/decisions/1/supersede', { text: 't', context: 1 }, /context must be a string/],
    ['decision supersede context cap', 'POST', '/v1/decisions/1/supersede', { text: 't', context: long(4096) }, /context exceeds 4096/],
    ['incident context type', 'POST', '/v1/incidents', { text: 't', context: 1 }, /context must be a string/],
    ['incident context cap', 'POST', '/v1/incidents', { text: 't', context: long(4096) }, /context exceeds 4096/],
    ['incident linked type', 'POST', '/v1/incidents', { text: 't', linkedMemoryIds: 'mem_1' }, /must be an array of memory ids/],
    ['incident linked cap', 'POST', '/v1/incidents', { text: 't', linkedMemoryIds: Array.from({ length: 257 }, (_, i) => `m${i}`) }, /exceeds 256-item cap/],
    ['incident linked entry', 'POST', '/v1/incidents', { text: 't', linkedMemoryIds: [''] }, /each linkedMemoryIds entry/],
    ['incident resolution cap', 'POST', '/v1/incidents/1/resolve', { resolutionText: long(4096) }, /resolutionText exceeds 4096/],
    ['process name cap', 'POST', '/v1/processes', { processName: long(4096) }, /processName exceeds 4096/],
    ['process steps type', 'POST', '/v1/processes', { processName: 'p', steps: 'tag' }, /steps must be an array of strings/],
    ['process step type', 'POST', '/v1/processes', { processName: 'p', steps: [1] }, /each step must be a string/],
    ['process step empty', 'POST', '/v1/processes', { processName: 'p', steps: ['  '] }, /a step is empty/],
    ['process step cap', 'POST', '/v1/processes', { processName: 'p', steps: [long(2000)] }, /a step exceeds the 2000-character cap/],
    ['process description type', 'POST', '/v1/processes', { processName: 'p', description: 1 }, /description must be a string/],
    ['process description cap', 'POST', '/v1/processes', { processName: 'p', description: long(4096) }, /description exceeds 4096/],
    ['process supersede change type', 'POST', '/v1/processes/1/supersede', { steps: ['a'], changeSummary: 1 }, /changeSummary must be a string/],
    ['process supersede change cap', 'POST', '/v1/processes/1/supersede', { steps: ['a'], changeSummary: long(4096) }, /changeSummary exceeds 4096/],
    ['process supersede description type', 'POST', '/v1/processes/1/supersede', { steps: ['a'], description: 1 }, /description must be a string/],
    ['process supersede description cap', 'POST', '/v1/processes/1/supersede', { steps: ['a'], description: long(4096) }, /description exceeds 4096/],
    ['policy name cap', 'POST', '/v1/policies', { policyName: long(4096), policyText: 't' }, /policyName exceeds 4096/],
    ['policy text', 'POST', '/v1/policies', { policyName: 'p' }, /policyText is required/],
    ['policy validFrom type', 'POST', '/v1/policies', { policyName: 'p', policyText: 't', validFrom: 1 }, /validFrom must be a string/],
    ['policy validTo cap', 'POST', '/v1/policies', { policyName: 'p', policyText: 't', validTo: long(64) }, /validTo exceeds 64-character cap/],
    ['policy supersede text cap', 'POST', '/v1/policies/1/supersede', { policyText: long(4096) }, /policyText exceeds 4096/],
    ['policy supersede change type', 'POST', '/v1/policies/1/supersede', { policyText: 't', changeSummary: 1 }, /changeSummary must be a string/],
    ['policy supersede change cap', 'POST', '/v1/policies/1/supersede', { policyText: 't', changeSummary: long(4096) }, /changeSummary exceeds 4096/],
    ['skill name cap', 'POST', '/v1/skills', { skillName: long(256), instructions: 'i' }, /skillName exceeds 256/],
    ['skill instructions', 'POST', '/v1/skills', { skillName: 's' }, /instructions are required/],
    ['skill trigger type', 'POST', '/v1/skills', { skillName: 's', instructions: 'i', trigger: 1 }, /trigger must be a string/],
    ['skill trigger cap', 'POST', '/v1/skills', { skillName: 's', instructions: 'i', trigger: long(1024) }, /trigger exceeds 1024/],
    ['skill supersede instructions cap', 'POST', '/v1/skills/1/supersede', { instructions: long(8192) }, /instructions exceed 8192/],
    ['skill supersede trigger type', 'POST', '/v1/skills/1/supersede', { instructions: 'i', trigger: 1 }, /trigger must be a string/],
    ['skill supersede trigger cap', 'POST', '/v1/skills/1/supersede', { instructions: 'i', trigger: long(1024) }, /trigger exceeds 1024/],
    ['skill supersede change type', 'POST', '/v1/skills/1/supersede', { instructions: 'i', changeSummary: 1 }, /changeSummary must be a string/],
    ['skill supersede change cap', 'POST', '/v1/skills/1/supersede', { instructions: 'i', changeSummary: long(4096) }, /changeSummary exceeds 4096/],
    ['brief repo cap', 'POST', '/v1/project-briefs', { repo: long(256), summary: 's' }, /repo exceeds 256/],
    ['brief summary', 'POST', '/v1/project-briefs', { repo: 'r' }, /summary is required/],
    ['brief refresh repo cap', 'POST', '/v1/project-briefs/refresh', { repo: long(256) }, /repo exceeds 256/],
    ['brief supersede summary cap', 'POST', '/v1/project-briefs/1/supersede', { summary: long(8192) }, /summary exceeds 8192/],
    ['brief supersede change type', 'POST', '/v1/project-briefs/1/supersede', { summary: 's', changeSummary: 1 }, /changeSummary must be a string/],
    ['brief supersede change cap', 'POST', '/v1/project-briefs/1/supersede', { summary: 's', changeSummary: long(4096) }, /changeSummary exceeds 4096/],
    ['note customer cap', 'POST', '/v1/customer-notes', { customer: long(256), note: 'n' }, /customer exceeds 256/],
    ['note text', 'POST', '/v1/customer-notes', { customer: 'c' }, /note is required/],
    ['note supersede text cap', 'POST', '/v1/customer-notes/1/supersede', { note: long(8192) }, /note exceeds 8192/],
    ['note supersede change type', 'POST', '/v1/customer-notes/1/supersede', { note: 'n', changeSummary: 1 }, /changeSummary must be a string/],
    ['note supersede change cap', 'POST', '/v1/customer-notes/1/supersede', { note: 'n', changeSummary: long(4096) }, /changeSummary exceeds 4096/],
    ['graph entity cap', 'GET', `/v1/graph?entity=${long(512)}`, undefined, /entity exceeds the 512-character cap/],
    ['context scope cap', 'GET', `/v1/context?scope=${long(256)}`, undefined, /scope exceeds 256-character cap/],
    ['context include_recent', 'GET', '/v1/context?include_recent=-1', undefined, /include_recent must be a non-negative number/],
    ['quarantine status', 'GET', '/v1/quarantine?status=maybe', undefined, /status must be one of: pending/],
    ['prediction list closed needs class', 'GET', '/v1/predictions?status=closed', undefined, /requires class param/],
    ['prediction stats class cap', 'GET', `/v1/predictions/stats?class=${long(256)}`, undefined, /class exceeds 256/],
  ];

  it.each(bad)('%s is a 400 that names the problem', async (_name, method, path, body, message) => {
    const r = await call(method, path, body);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(message);
  });

  it('none of the rejected writes reached the store', async () => {
    const counts = await Promise.all([
      ['/v1/decisions?status=all', 'decisions'], ['/v1/incidents?status=all', 'incidents'], ['/v1/processes?status=all', 'processes'],
      ['/v1/policies?status=all', 'policies'], ['/v1/skills?status=all', 'skills'], ['/v1/project-briefs?status=all', 'briefs'],
      ['/v1/customer-notes?status=all', 'notes'], ['/v1/predictions?status=all', 'predictions'],
    ].map(async ([path, key]) => {
      const r = await call('GET', path);
      expect(r.status).toBe(200);
      const rows = r.json[key];
      return [key, Array.isArray(rows) ? rows.length : -1];
    }));
    expect(Object.fromEntries(counts)).toEqual({ decisions: 1, incidents: 0, processes: 1, policies: 1, skills: 1, briefs: 1, notes: 1, predictions: 1 });
  });

  it('supersede of a row that does not exist is a 404 on every versioned kind', async () => {
    const cases: Array<[string, Body]> = [
      ['processes', { steps: ['a'] }], ['policies', { policyText: 't' }], ['skills', { instructions: 'i' }],
      ['project-briefs', { summary: 's' }], ['customer-notes', { note: 'n' }],
    ];
    for (const [kind, body] of cases) {
      const r = await call('POST', `/v1/${kind}/99999/supersede`, body);
      expect([kind, r.status]).toEqual([kind, 404]);
      expect(String(r.json.error)).toMatch(/99999 not found/);
    }
  });

  it('a create that points at a missing row is a 409, not a 404', async () => {
    const decision = await call('POST', '/v1/decisions', { text: 'replace it', supersedesDecisionId: 99999 });
    expect(decision.status).toBe(409);
    expect(String(decision.json.error)).toContain('to supersede not found');
    const incident = await call('POST', '/v1/incidents', { text: 'outage', linkedMemoryIds: ['mem_does_not_exist'] });
    expect(incident.status).toBe(409);
  });

  // Decision supersede answers 201 but process and skill answer 200; this pins today's contract.
  it('a supersede carries its optional context, description and trigger into the new version', async () => {
    const d = await call('POST', `/v1/decisions/${ids.decision}/supersede`, { text: 'use postgres', context: 'scale' });
    expect(d.status).toBe(201);
    expect(d.json.decision).toMatchObject({ context: 'scale' });
    const p = await call('POST', `/v1/processes/${ids.process}/supersede`, { steps: ['tag', 'sign', 'publish'], description: 'signed now' });
    expect(p.status).toBe(200);
    expect(p.json.process).toMatchObject({ description: 'signed now', steps: ['tag', 'sign', 'publish'] });
    const s = await call('POST', `/v1/skills/${ids.skill}/supersede`, { instructions: 'halve it', trigger: 'flaky test' });
    expect(s.status).toBe(200);
    expect(s.json.skill).toMatchObject({ trigger: 'flaky test' });
  });

  it('closed predictions are listed by class once one is closed', async () => {
    const close = await call('POST', `/v1/predictions/${ids.prediction}/close`, { state: 'closed', actual: 3, note: 'slipped' });
    expect(close.status).toBe(200);
    const r = await call('GET', '/v1/predictions?status=closed&class=release');
    expect(r.status).toBe(200);
    expect(r.json.predictions).toEqual([expect.objectContaining({ id: ids.prediction })]);
  });

  it('include_recent is accepted, and audit since filters by time', async () => {
    expect((await call('GET', '/v1/context?include_recent=2')).status).toBe(200);
    const since = async (iso: string): Promise<number> => {
      const r = await call('GET', `/v1/audit?since=${encodeURIComponent(iso)}`);
      expect(r.status).toBe(200);
      // /v1/audit answers auditList's event array as the whole body.
      return Array.isArray(r.json) ? r.json.length : -1;
    };
    expect(await since('2020-01-01T00:00:00Z')).toBeGreaterThan(0);
    expect(await since('2999-01-01T00:00:00Z')).toBe(0);
  });

  it('a malformed Authorization header on /mcp is a 401', async () => {
    const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid api key');
  });

  it('a request target the URL parser rejects is a 400, not a 500', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(new URL(handle.url).port), path: '//[', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});
