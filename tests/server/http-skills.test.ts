/**
 * E2 skill first-class object (executable/exportable) - HTTP route parity test.
 * Docs: docs/plans/2026-05-30-e2-skill-object.md
 *
 * Covers what only skills have; the shared route rules run per kind in http-objects.test.ts.
 * 1. GET /v1/skills lists + status filter
 * 2. GET /v1/skills/export renders active skills markdown (+ not-404-as-id)
 * 3. the export is tenant-scoped
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../../src/store/auth.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import type { Skill } from '../../src/objects/skills.js';
import { makeRoot } from '../_helpers/make-root.js';

/** Parse a fetch Response body against a caller-declared shape. */
async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only used against this file's own /v1/skills route responses,
  // whose JSON shape is fixed by the handler in src/server.ts and checked by
  // the assertions immediately following each call site.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;
let apiKey: CreateApiKeyResult;
let apiKeyB: CreateApiKeyResult;

beforeEach(async () => {
  home = makeRoot('http-skill');
  const db = openHippoDb(home);
  try {
    apiKey = createApiKey(db, { tenantId: 'default', label: 'test-skill', role: 'admin' });
    apiKeyB = createApiKey(db, { tenantId: 'tenant-b', label: 'test-skill-b', role: 'admin' });
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
interface CreateSkillBody {
  skillName: string;
  instructions: string;
  trigger?: string;
}

async function createSkill(body: CreateSkillBody, key: CreateApiKeyResult = apiKey) {
  return fetch(`${handle.url}/v1/skills`, { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) });
}

describe('HTTP /v1/skills (executable/exportable first-class object)', () => {
  it('GET /v1/skills lists + filters by status', async () => {
    const v1 = (await jsonAs<{ skill: Skill }>(await createSkill({ skillName: 'S', instructions: 'a' }))).skill;
    await fetch(`${handle.url}/v1/skills/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ instructions: 'b', changeSummary: 'c' }),
    });
    const all = await jsonAs<{ skills: Skill[] }>(await fetch(`${handle.url}/v1/skills`, { headers: authHeaders() }));
    expect(all.skills.length).toBe(2);
    const active = await jsonAs<{ skills: Skill[] }>(await fetch(`${handle.url}/v1/skills?status=active`, { headers: authHeaders() }));
    expect(active.skills.length).toBe(1);
    expect(active.skills[0].version).toBe(2);
  });

  it('GET /v1/skills/export renders active skills markdown (and is not captured as an :id)', async () => {
    await createSkill({ skillName: 'Alpha', instructions: 'do alpha', trigger: 'on start' });
    await createSkill({ skillName: 'Bravo', instructions: 'do bravo' });
    const res = await fetch(`${handle.url}/v1/skills/export`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ markdown: string }>(res);
    expect(body.markdown).toContain('## Alpha');
    expect(body.markdown).toContain('**When:** on start');
    expect(body.markdown).toContain('## Bravo');
    // name-ASC order
    expect(body.markdown.indexOf('## Alpha')).toBeLessThan(body.markdown.indexOf('## Bravo'));
  });

  it('cross-tenant isolation: tenant-b export holds no default-tenant skill', async () => {
    await createSkill({ skillName: 'secret', instructions: 'a' });
    const bExport = await jsonAs<{ markdown: string }>(await fetch(`${handle.url}/v1/skills/export`, { headers: authHeaders(apiKeyB) }));
    expect(bExport.markdown).toBe('');
  });
});
