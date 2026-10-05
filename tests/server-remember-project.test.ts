// POST /v1/memories stamps the caller's `project.name`, or NULL on a shared store, and never the served folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { adminActor, type Context } from '../src/api.js';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import type { JsonValue } from '../src/json.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';
import { promptHookContext } from '../src/prompt-hook.js';
import { serve, type ServerHandle } from '../src/server.js';

const ROW = 'the zorblaxian quintessor needs a restart every monday';
const PROMPT = 'how do I restart the zorblaxian quintessor';

let tmp: string;
let store: string;
let handle: ServerHandle | null = null;
const origHome = process.env.HIPPO_HOME;

/** Serves `<tmp>/srv/hippo-team`, a folder with no project marker, so the folder stamp is '' (user-global). */
async function start(config: Record<string, JsonValue>): Promise<ServerHandle> {
  store = path.join(tmp, 'srv', 'hippo-team');
  fs.mkdirSync(store, { recursive: true });
  initStore(store);
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify(config));
  handle = await serve({ hippoRoot: store, port: 0 });
  return handle;
}

async function post(h: ServerHandle, body: Record<string, JsonValue>): Promise<{ status: number; id?: string }> {
  const res = await fetch(`${h.url}/v1/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // SAFETY: the create route answers `{ id, ... }` on 200 and `{ error }` otherwise; only `id` is read.
  const json = (await res.json()) as { id?: string };
  return { status: res.status, id: json.id };
}

async function originAfterPost(h: ServerHandle, body: Record<string, JsonValue>): Promise<string | null | undefined> {
  const { status, id } = await post(h, body);
  expect(status).toBe(200);
  return readEntry(store, id ?? '')?.origin_project;
}

async function hookText(project: string): Promise<string> {
  const ctx: Context = { hippoRoot: store, tenantId: 'default', actor: adminActor('remember-project-test') };
  const req = { sessionId: `s-${project}`, project: { name: project, legacyName: project }, payload: { prompt: PROMPT } };
  return (await promptHookContext(ctx, req, { sharedStore: true })).stdout;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-remember-project-'));
  process.env.HIPPO_HOME = path.join(tmp, 'global');
  clearProjectIdentityCache();
  _resetSharedStoreCacheForTests();
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (origHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = origHome;
  _resetSharedStoreCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /v1/memories on a shared store', () => {
  it("stores the caller's project name", async () => {
    const h = await start({ sharedStore: true });
    expect(await originAfterPost(h, { content: ROW, project: { name: 'acme/app' } })).toBe('acme/app');
  });

  it('stores NULL when the caller names no project', async () => {
    const h = await start({ sharedStore: true });
    expect(await originAfterPost(h, { content: ROW })).toBeNull();
  });

  it('answers 400 and writes nothing for a malformed or refused project', async () => {
    const h = await start({ sharedStore: true });
    const eleven = Array.from({ length: 11 }, (_, i) => `a${i}`);
    const refused: readonly JsonValue[] = [
      'x',
      { name: 5 },
      { name: 'acme/app', aliases: 'a' },
      { name: 'acme/app', aliases: eleven },
      { name: 'x'.repeat(257) },
      { name: '' },
    ];
    for (const project of refused) {
      expect((await post(h, { content: ROW, project })).status, JSON.stringify(project).slice(0, 60)).toBe(400);
    }
    expect(loadAllEntries(store)).toHaveLength(0);
  });

  it('ignores legacy_name, so a folder name never lands', async () => {
    const h = await start({ sharedStore: true });
    expect(await originAfterPost(h, { content: ROW, project: { name: 'acme/app', legacy_name: 'hippo-team' } })).toBe('acme/app');
  });

  it("a row posted with no project never reaches another project's prompt context", async () => {
    const h = await start({ sharedStore: true, pinnedInject: { promptRecall: true } });
    await originAfterPost(h, { content: ROW });
    expect(await hookText('other')).not.toContain('zorblaxian');
  });

  it('a row posted with a project reaches that project and no other', async () => {
    const h = await start({ sharedStore: true, pinnedInject: { promptRecall: true } });
    await originAfterPost(h, { content: ROW, project: { name: 'acme/app' } });
    expect(await hookText('acme/app')).toContain('zorblaxian');
    expect(await hookText('other')).not.toContain('zorblaxian');
  });
});

describe('POST /v1/memories on a store that is not shared', () => {
  it('stores the folder stamp when the caller names no project', async () => {
    const h = await start({});
    expect(await originAfterPost(h, { content: ROW })).toBe('');
  });
});
