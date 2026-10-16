/**
 * E2 project_brief first-class object (repo-scoped / auto-refreshes) - HTTP route test.
 * Docs: docs/plans/2026-05-30-e2-project-brief-object.md
 *
 * Covers what only project briefs have; the shared route rules run per kind in http-objects.test.ts.
 * 1. GET /v1/project-briefs lists + status filter + repo filter
 * 2. POST /v1/project-briefs/refresh writes a brief; dryRun returns {markdown} without writing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import type { ProjectBrief } from '../src/objects/project-briefs.js';
import { makeRoot } from './_helpers/make-root.js';

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

beforeEach(async () => {
  home = makeRoot('http-brief');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-brief', role: 'admin' });
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
});
