// A personal write lands in the caller's own scope with origin '', and no client, vault or CLI can type a personal scope.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remember, type Actor, type Context } from '../src/api.js';
import { BadRequestError } from '../src/api-errors.js';
import { createApiKey } from '../src/auth.js';
import { cmdRemember } from '../src/cli/remember.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { mapApiError } from '../src/http-util.js';
import { importVault } from '../src/importers/vault.js';
import type { JsonValue } from '../src/json.js';
import { serve, type ServerHandle } from '../src/server.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

const NO_OWNER_TEXT = 'personal memories need a key its owner minted, or a sign-in; owner ids over 239 characters or with control characters cannot hold them';

let root: string;

function ctxFor(actor: Actor): Context {
  return { hippoRoot: root, tenantId: 'default', actor };
}

const ownerA: Actor = { subject: 'api_key:hk_a', role: 'member', owner: 'a' };

/** Status and message the HTTP layer would answer with for a refused call. */
function refusal(fn: () => void): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    return mapApiError(err);
  }
  throw new Error('expected the call to be refused');
}

beforeEach(() => {
  root = makeRoot('personal-write', { config: { embeddings: { enabled: false } } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('remember with personal', () => {
  it('stamps the owner\'s scope and origin \'\' even when the caller names a project', () => {
    const { id } = remember(ctxFor(ownerA), { content: 'my editor keybindings live in dotfiles', personal: true, project: { name: 'alpha' } });
    const row = readEntry(root, id, 'default');
    expect(row?.scope).toBe('personal:private:a');
    expect(row?.origin_project).toBe('');
  });

  it('a team write with the same project still stamps that project, so the personal branch is what drops it', () => {
    const { id } = remember(ctxFor(ownerA), { content: 'the alpha build runs on node 22', project: { name: 'alpha' } });
    const row = readEntry(root, id, 'default');
    expect(row?.scope).toBeNull();
    expect(row?.origin_project).toBe('alpha');
  });

  const ownerless: ReadonlyArray<[string, Actor]> = [
    ['no owner', { subject: 'localhost:cli', role: 'admin' }],
    ['an empty owner', { subject: 'api_key:hk_e', role: 'member', owner: '' }],
    ['a 240-character owner', { subject: 'api_key:hk_l', role: 'member', owner: 'x'.repeat(240) }],
    ['a control character in the owner', { subject: 'api_key:hk_c', role: 'member', owner: 'a\u0007b' }],
  ];
  it.each(ownerless)('%s gets a 400 and stores nothing', (_label, actor) => {
    expect(refusal(() => remember(ctxFor(actor), { content: 'note for later', personal: true }))).toEqual({ status: 400, message: NO_OWNER_TEXT });
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('a 239-character owner fits', () => {
    const owner = 'y'.repeat(239);
    const { id } = remember(ctxFor({ subject: 'api_key:hk_y', role: 'member', owner }), { content: 'longest owner note', personal: true });
    expect(readEntry(root, id, 'default')?.scope).toBe(`personal:private:${owner}`);
  });

  it('personal with a scope is a 400', () => {
    expect(refusal(() => remember(ctxFor(ownerA), { content: 'note', personal: true, scope: 'team' })))
      .toEqual({ status: 400, message: 'send personal or scope, not both' });
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('personal with untrusted throws a plain error, never a quarantine row', () => {
    const fn = (): void => { remember(ctxFor(ownerA), { content: 'note', personal: true, untrusted: true }); };
    expect(fn).toThrow(Error);
    expect(refusal(fn).status).toBe(500);
    expect(loadAllEntries(root)).toHaveLength(0);
  });
});

describe('client scopes', () => {
  it.each(['personal:private:b', 'Personal:x'])('remember refuses %s with a 400', (scope) => {
    expect(refusal(() => remember(ctxFor(ownerA), { content: 'note', scope })).status).toBe(400);
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('a connector scope still passes', () => {
    const { id } = remember(ctxFor(ownerA), { content: 'channel note', scope: 'slack:private:C1' });
    expect(readEntry(root, id, 'default')?.scope).toBe('slack:private:C1');
  });

  it('vault import refuses a personal scope before reading a note', () => {
    const vault = mkdtempSync(join(tmpdir(), 'hippo-personal-vault-'));
    try {
      writeFileSync(join(vault, 'note.md'), '# note\nsome vault text\n');
      expect(() => importVault(vault, { hippoRoot: root, tenantId: 'default', name: 'v', scope: 'personal:private:b' })).toThrow(BadRequestError);
      expect(() => importVault(vault, { hippoRoot: root, tenantId: 'default', name: 'v', scope: 'PERSONAL:x' })).toThrow(BadRequestError);
      expect(loadAllEntries(root)).toHaveLength(0);
      importVault(vault, { hippoRoot: root, tenantId: 'default', name: 'v', scope: 'vault:private:v' });
      expect(loadAllEntries(root).map((e) => e.scope)).toEqual(['vault:private:v']);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('CLI remember --scope refuses a personal scope', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(cmdRemember(root, 'cli personal attempt', { force: true, scope: 'personal:private:b' })).rejects.toThrow(BadRequestError);
      expect(loadAllEntries(root)).toHaveLength(0);
      await cmdRemember(root, 'cli team note', { force: true, scope: 'team' });
    } finally {
      log.mockRestore();
    }
    expect(loadAllEntries(root).map((e) => e.scope)).toEqual(['team']);
  });
});

describe('POST /v1/memories personal field', () => {
  let handle: ServerHandle;
  let ownedKey: string;

  beforeEach(async () => {
    const db = openHippoDb(root);
    try {
      ownedKey = createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: 'oid-a' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  function post(body: Record<string, JsonValue>): Promise<Response> {
    return fetch(`${handle.url}/v1/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownedKey}` },
      body: JSON.stringify(body),
    });
  }

  it.each(['yes', 1, null])('personal: %j is a 400', async (personal) => {
    const res = await post({ content: 'a note', personal });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'personal must be a boolean' });
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('personal: true stores the key owner\'s scope and drops a well-formed project', async () => {
    const res = await post({ content: 'my own terminal theme', personal: true, project: { name: 'alpha' } });
    expect(res.status).toBe(200);
    // SAFETY: a 200 from POST /v1/memories is a RememberResult, which carries the new row's id.
    const { id } = await res.json() as { id: string };
    const row = readEntry(root, id, 'default');
    expect(row?.scope).toBe('personal:private:oid-a');
    expect(row?.origin_project).toBe('');
  });

  it('a malformed project is still a 400 with personal: true', async () => {
    const res = await post({ content: 'a note', personal: true, project: 'alpha' });
    expect(res.status).toBe(400);
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('personal: false is a team write', async () => {
    const res = await post({ content: 'team note via the route', personal: false });
    expect(res.status).toBe(200);
    expect(loadAllEntries(root).map((e) => e.scope)).toEqual([null]);
  });
});
