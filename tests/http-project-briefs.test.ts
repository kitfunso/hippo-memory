/**
 * E2 project_brief first-class object (repo-scoped / auto-refreshes) - HTTP route test.
 * Docs: docs/plans/2026-05-30-e2-project-brief-object.md
 *
 * Covers:
 * 1. POST /v1/project-briefs creates (201 + brief, version 1)
 * 2. GET /v1/project-briefs lists + status filter + repo filter
 * 3. POST /v1/project-briefs/refresh writes a brief; dryRun returns {markdown} without writing
 * 4. GET /v1/project-briefs/:id + 404
 * 5. POST /v1/project-briefs/:id/supersede (+409 on re-supersede)
 * 6. POST /v1/project-briefs/:id/close (+409 on re-close)
 * 7. Bearer auth gate (401)
 * 8. status filter validation (400); fractional limit (400, shared parseListLimit)
 * 9. cross-tenant isolation
 * 10. DoS cap on summary (400)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { ProjectBrief } from '../src/objects/project-briefs.js';
import type { JsonValue } from '../src/util/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

type BriefResponse = { brief: ProjectBrief };
type BriefListResponse = { briefs: ProjectBrief[] };
type RefreshDryRunResponse = { markdown: string; receiptCount: number };

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only called against the /v1/project-briefs routes under test in this file;
  // each call site's explicit type argument and the assertions that follow it pin the
  // actual response shape.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-brief');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-brief', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-brief-b', role: 'admin' });
  } finally { closeHippoDb(db); }
  handle = await serve({ hippoRoot: home, port: 0 });
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

function authHeaders(key: CreateApiKeyResult = apiKey) {
  return { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' };
}
async function createBrief(body: { repo: string; summary: string }, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/project-briefs`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/project-briefs (repo-scoped first-class object)', () => {
  it('POST /v1/project-briefs creates a brief (201 + brief, version 1)', async () => {
    const res = await createBrief({ repo: 'hippo', summary: 'agent-memory lib' });
    expect(res.status).toBe(201);
    const body = await jsonAs<BriefResponse>(res);
    expect(body.brief.repo).toBe('hippo');
    expect(body.brief.summary).toBe('agent-memory lib');
    expect(body.brief.version).toBe(1);
    expect(body.brief.status).toBe('active');
  });

  it('GET /v1/project-briefs lists + filters by status + repo', async () => {
    const v1 = (await jsonAs<BriefResponse>(await createBrief({ repo: 'r', summary: 'a' }))).brief;
    await createBrief({ repo: 'other', summary: 'x' });
    await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'b', changeSummary: 'c' }),
    });
    const all = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs`, { headers: authHeaders() }));
    expect(all.briefs.length).toBe(3);
    const repoR = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs?repo=r`, { headers: authHeaders() }));
    expect(repoR.briefs.length).toBe(2);
    const padded = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs?repo=%20r%20`, { headers: authHeaders() }));
    expect(padded.briefs.length).toBe(2); // the filter is trimmed before the lookup
    const active = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs?repo=r&status=active`, { headers: authHeaders() }));
    expect(active.briefs.length).toBe(1);
    expect(active.briefs[0].version).toBe(2);
  });

  it('POST /v1/project-briefs/refresh writes a brief; dryRun returns markdown without writing', async () => {
    // dry-run on an empty repo: returns a valid digest, writes nothing
    const dry = await fetch(`${handle.url}/v1/project-briefs/refresh`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ repo: 'hippo', dryRun: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = await jsonAs<RefreshDryRunResponse>(dry);
    expect(dryBody.receiptCount).toBe(0);
    expect(dryBody.markdown).toContain('# Project Brief: hippo');
    const afterDry = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs?repo=hippo`, { headers: authHeaders() }));
    expect(afterDry.briefs.length).toBe(0);

    // real refresh writes v1
    const res = await fetch(`${handle.url}/v1/project-briefs/refresh`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ repo: 'hippo' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<BriefResponse>(res);
    expect(body.brief.version).toBe(1);
    expect(body.brief.repo).toBe('hippo');
    const after = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs?repo=hippo`, { headers: authHeaders() }));
    expect(after.briefs.length).toBe(1);
  });

  it('GET /v1/project-briefs/:id + 404 on missing', async () => {
    const created = (await jsonAs<BriefResponse>(await createBrief({ repo: 'x', summary: 'a' }))).brief;
    expect((await fetch(`${handle.url}/v1/project-briefs/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/project-briefs/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/project-briefs/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await jsonAs<BriefResponse>(await createBrief({ repo: 'b', summary: 'a' }))).brief;
    const sup = await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await jsonAs<BriefResponse>(sup)).brief.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/project-briefs/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ summary: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/project-briefs/:id/close retires (+409 on re-close)', async () => {
    const b = (await jsonAs<BriefResponse>(await createBrief({ repo: 'c', summary: 'a' }))).brief;
    expect((await fetch(`${handle.url}/v1/project-briefs/${b.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/project-briefs/${b.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/project-briefs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'x', summary: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH; else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter (400) + fractional limit (400, shared parseListLimit)', async () => {
    expect((await fetch(`${handle.url}/v1/project-briefs?status=retired`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/project-briefs?limit=1.5`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/project-briefs?limit=5`, { headers: authHeaders() })).status).toBe(200);
  });

  it('cross-tenant isolation: tenant-b cannot see default briefs', async () => {
    const created = (await jsonAs<BriefResponse>(await createBrief({ repo: 'secret', summary: 'a' }))).brief;
    const bList = await jsonAs<BriefListResponse>(await fetch(`${handle.url}/v1/project-briefs`, { headers: authHeaders(apiKeyB) }));
    expect(bList.briefs.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/project-briefs/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
  });

  it('DoS cap on summary (400)', async () => {
    expect((await createBrief({ repo: 'x', summary: 'y'.repeat(8193) })).status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/project-briefs';
  const REFRESH = '/v1/project-briefs/refresh';
  const MISSING = '/v1/project-briefs/99999/supersede';
  // Each row also sends every later field invalid, and the supersede target does not exist,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: blank repo', 'POST', ROOT, { repo: '  ', summary: 7 }, 400, 'repo is required (non-empty string)'],
    ['create: repo over the cap', 'POST', ROOT, { repo: over(256), summary: 7 }, 400, 'repo exceeds 256-character cap'],
    ['create: blank summary', 'POST', ROOT, { repo: 'r', summary: '  ' }, 400, 'summary is required (non-empty string)'],
    ['create: summary over the cap', 'POST', ROOT, { repo: 'r', summary: over(8192) }, 400, 'summary exceeds 8192-character cap'],
    ['refresh: blank repo', 'POST', REFRESH, { repo: '  ', dryRun: true }, 400, 'repo is required (non-empty string)'],
    ['refresh: repo over the cap', 'POST', REFRESH, { repo: over(256), dryRun: true }, 400, 'repo exceeds 256-character cap'],
    ['supersede: blank summary', 'POST', MISSING, { summary: '  ', changeSummary: 7 }, 400, 'summary is required (non-empty string)'],
    ['supersede: summary over the cap', 'POST', MISSING, { summary: over(8192), changeSummary: 7 }, 400, 'summary exceeds 8192-character cap'],
    ['supersede: changeSummary not a string', 'POST', MISSING, { summary: 's', changeSummary: 7 }, 400, 'changeSummary must be a string'],
    ['supersede: changeSummary over the cap', 'POST', MISSING, { summary: 's', changeSummary: over(4096) }, 400, 'changeSummary exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the lookup', 'POST', MISSING, { summary: at(8192), changeSummary: at(4096) }, 404, 'project brief 99999 not found'],
    ['supersede: a null changeSummary reaches the lookup', 'POST', MISSING, { summary: 's', changeSummary: null }, 404, 'project brief 99999 not found'],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
