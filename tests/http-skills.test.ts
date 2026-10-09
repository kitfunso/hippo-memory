/**
 * E2 skill first-class object (executable/exportable) - HTTP route parity test.
 * Docs: docs/plans/2026-05-30-e2-skill-object.md
 *
 * Covers:
 * 1. POST /v1/skills creates (201 + Skill, version 1)
 * 2. GET /v1/skills lists + status filter
 * 3. GET /v1/skills/export renders active skills markdown (+ not-404-as-id)
 * 4. GET /v1/skills/:id + 404
 * 5. POST /v1/skills/:id/supersede (+409 on re-supersede)
 * 6. POST /v1/skills/:id/close (+409 on re-close)
 * 7. Bearer auth gate (401)
 * 8. status filter validation (400); fractional limit (400, shared parseListLimit)
 * 9. cross-tenant isolation
 * 10. DoS cap on instructions (400)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import { createApiKey, type CreateApiKeyResult } from '../src/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import type { Skill } from '../src/skills.js';
import type { JsonValue } from '../src/json.js';
import { makeRoot } from './_helpers/make-root.js';

type Body = { [key: string]: JsonValue };

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

describe('HTTP /v1/skills (E2 executable/exportable first-class object)', () => {
  it('POST /v1/skills creates a skill (201 + Skill, version 1)', async () => {
    const res = await createSkill({ skillName: 'Run tests', instructions: 'npm test', trigger: 'before commit' });
    expect(res.status).toBe(201);
    const body = await jsonAs<{ skill: Skill }>(res);
    expect(body.skill.skillName).toBe('Run tests');
    expect(body.skill.trigger).toBe('before commit');
    expect(body.skill.version).toBe(1);
    expect(body.skill.status).toBe('active');
  });

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

  it('GET /v1/skills/:id + 404 on missing', async () => {
    const created = (await jsonAs<{ skill: Skill }>(await createSkill({ skillName: 'X', instructions: 'a' }))).skill;
    expect((await fetch(`${handle.url}/v1/skills/${created.id}`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/skills/99999`, { headers: authHeaders() })).status).toBe(404);
  });

  it('POST /v1/skills/:id/supersede creates v2 (+409 on re-supersede)', async () => {
    const v1 = (await jsonAs<{ skill: Skill }>(await createSkill({ skillName: 'B', instructions: 'a' }))).skill;
    const sup = await fetch(`${handle.url}/v1/skills/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ instructions: 'b', changeSummary: 'x' }),
    });
    expect(sup.status).toBe(200);
    expect((await jsonAs<{ skill: Skill }>(sup)).skill.version).toBe(2);
    const conflict = await fetch(`${handle.url}/v1/skills/${v1.id}/supersede`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ instructions: 'c' }),
    });
    expect(conflict.status).toBe(409);
  });

  it('POST /v1/skills/:id/close retires (+409 on re-close)', async () => {
    const s = (await jsonAs<{ skill: Skill }>(await createSkill({ skillName: 'C', instructions: 'a' }))).skill;
    expect((await fetch(`${handle.url}/v1/skills/${s.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${handle.url}/v1/skills/${s.id}/close`, { method: 'POST', headers: authHeaders() })).status).toBe(409);
  });

  it('route is auth-gated: HIPPO_REQUIRE_AUTH=1 + no Authorization -> 401', async () => {
    const prev = process.env.HIPPO_REQUIRE_AUTH;
    process.env.HIPPO_REQUIRE_AUTH = '1';
    try {
      const res = await fetch(`${handle.url}/v1/skills`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillName: 'x', instructions: 'y' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.HIPPO_REQUIRE_AUTH; else process.env.HIPPO_REQUIRE_AUTH = prev;
    }
  });

  it('status filter (400) + fractional limit (400, shared parseListLimit)', async () => {
    expect((await fetch(`${handle.url}/v1/skills?status=retired`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/skills?limit=1.5`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${handle.url}/v1/skills?limit=5`, { headers: authHeaders() })).status).toBe(200);
  });

  it('cross-tenant isolation: tenant-b cannot see default skills (incl export)', async () => {
    const created = (await jsonAs<{ skill: Skill }>(await createSkill({ skillName: 'secret', instructions: 'a' }))).skill;
    const bList = await jsonAs<{ skills: Skill[] }>(await fetch(`${handle.url}/v1/skills`, { headers: authHeaders(apiKeyB) }));
    expect(bList.skills.length).toBe(0);
    expect((await fetch(`${handle.url}/v1/skills/${created.id}`, { headers: authHeaders(apiKeyB) })).status).toBe(404);
    const bExport = await jsonAs<{ markdown: string }>(await fetch(`${handle.url}/v1/skills/export`, { headers: authHeaders(apiKeyB) }));
    expect(bExport.markdown).toBe('');
  });

  it('DoS cap on instructions (400)', async () => {
    expect((await createSkill({ skillName: 'x', instructions: 'y'.repeat(8193) })).status).toBe(400);
  });

  const over = (cap: number): string => 'x'.repeat(cap + 1);
  const at = (cap: number): string => 'x'.repeat(cap);
  const ROOT = '/v1/skills';
  const MISSING = '/v1/skills/99999/supersede';
  // Each row also sends every later field invalid, and the supersede target does not exist,
  // so a row pins which check answers first as well as the reply text.
  const REPLIES: readonly (readonly [string, string, string, Body | undefined, number, string])[] = [
    ['list: an unknown status', 'GET', `${ROOT}?status=retired`, undefined, 400, 'status must be one of: active | superseded | closed | all (got "retired")'],
    ['create: blank skillName', 'POST', ROOT, { skillName: '  ', instructions: 7, trigger: 7 }, 400, 'skillName is required (non-empty string)'],
    ['create: skillName over the cap', 'POST', ROOT, { skillName: over(256), instructions: 7, trigger: 7 }, 400, 'skillName exceeds 256-character cap'],
    ['create: blank instructions', 'POST', ROOT, { skillName: 's', instructions: '  ', trigger: 7 }, 400, 'instructions are required (non-empty string)'],
    ['create: instructions over the cap', 'POST', ROOT, { skillName: 's', instructions: over(8192), trigger: 7 }, 400, 'instructions exceed 8192-character cap'],
    ['create: trigger not a string', 'POST', ROOT, { skillName: 's', instructions: 'i', trigger: 7 }, 400, 'trigger must be a string'],
    ['create: trigger over the cap', 'POST', ROOT, { skillName: 's', instructions: 'i', trigger: over(1024) }, 400, 'trigger exceeds 1024-character cap'],
    ['supersede: blank instructions', 'POST', MISSING, { instructions: '  ', trigger: 7, changeSummary: 7 }, 400, 'instructions are required (non-empty string)'],
    ['supersede: instructions over the cap', 'POST', MISSING, { instructions: over(8192), trigger: 7, changeSummary: 7 }, 400, 'instructions exceed 8192-character cap'],
    ['supersede: trigger not a string', 'POST', MISSING, { instructions: 'i', trigger: 7, changeSummary: 7 }, 400, 'trigger must be a string'],
    ['supersede: trigger over the cap', 'POST', MISSING, { instructions: 'i', trigger: over(1024), changeSummary: 7 }, 400, 'trigger exceeds 1024-character cap'],
    ['supersede: changeSummary not a string', 'POST', MISSING, { instructions: 'i', changeSummary: 7 }, 400, 'changeSummary must be a string'],
    ['supersede: changeSummary over the cap', 'POST', MISSING, { instructions: 'i', changeSummary: over(4096) }, 400, 'changeSummary exceeds 4096-character cap'],
    ['supersede: every field at its cap reaches the lookup', 'POST', MISSING, { instructions: at(8192), trigger: at(1024), changeSummary: at(4096) }, 404, 'skill 99999 not found'],
    ['supersede: null optional fields reach the lookup', 'POST', MISSING, { instructions: 'i', trigger: null, changeSummary: null }, 404, 'skill 99999 not found'],
  ];

  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
