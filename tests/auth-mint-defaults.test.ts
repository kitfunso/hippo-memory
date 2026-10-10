// A mint that names no role is a member key and one that names no expiry lasts 90 days; admin and no expiry are asked for by name.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, authCreate } from '../src/api/index.js';
import { handleAuth } from '../src/cli/auth.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { serve, type ServerHandle } from '../src/server.js';
import { EXPIRING_KEYS_MIN_BINARY } from '../src/util/version.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { hippoRun } from './_helpers/spawn-hippo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Minted {
  keyId: string;
  plaintext: string;
  role: string;
  expiresAt: string | null;
}

/** What a test posts to the mint route, the wrong types a caller might send included. */
interface MintBody {
  label?: string;
  role?: string;
  ttlDays?: number | string | null;
  noExpiry?: boolean | string | null;
}

interface ListedKey {
  keyId: string;
  role: string;
  expiresAt: string | null;
}

interface AuditRow {
  targetId: string;
  metadata: { label: string | null; role: string; expiresAt: string | null };
}

let home: string;
let globalHome: string;
let handle: ServerHandle;
let savedEnv: Array<[string, string | undefined]>;

async function jsonOf<T>(res: Response): Promise<T> {
  // SAFETY: each caller names the shape its route documents and asserts on the fields it reads.
  return (await res.json()) as T;
}

/** The host CLI's own path: it opens the store as host admin, so it needs no key to mint the first one. */
function hostMint(role: 'admin' | 'member'): Minted {
  return authCreate({ hippoRoot: home, tenantId: 'default', actor: adminActor('cli') }, { role, noExpiry: true });
}

function send(method: string, path: string, bearer: string, body?: MintBody): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const mintOver = (bearer: string, body: MintBody): Promise<Response> => send('POST', '/v1/auth/keys', bearer, body);

async function listed(bearer: string, keyId: string): Promise<ListedKey | undefined> {
  const keys = await jsonOf<ListedKey[]>(await send('GET', '/v1/auth/keys', bearer));
  return keys.find((k) => k.keyId === keyId);
}

function floor(): string | undefined {
  const db = openHippoDb(home);
  try {
    // SAFETY: the meta table's value column is TEXT; one row by primary key.
    return (db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string } | undefined)?.value;
  } finally {
    closeHippoDb(db);
  }
}

/** Whole days from now to `iso`, so a test reads the lifetime a mint chose without racing the clock. */
function daysUntil(iso: string | null): number {
  return iso === null ? Number.NaN : Math.round((Date.parse(iso) - Date.now()) / DAY_MS);
}

beforeEach(async () => {
  home = makeRoot('mint-defaults');
  globalHome = makeRoot('mint-defaults-global');
  savedEnv = ['HIPPO_HOME', 'HIPPO_REQUIRE_AUTH'].map((name) => [name, process.env[name]]);
  process.env.HIPPO_HOME = globalHome;
  process.env.HIPPO_REQUIRE_AUTH = '1';
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  vi.useRealTimers();
  await handle.stop();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(globalHome, { recursive: true, force: true });
});

describe('POST /v1/auth/keys defaults', () => {
  it('a mint with an empty body is a member key that expires in 90 days, in the reply and in the store', async () => {
    const admin = hostMint('admin');
    const res = await mintOver(admin.plaintext, {});
    expect(res.status).toBe(200);
    const made = await jsonOf<Minted>(res);
    expect([made.role, daysUntil(made.expiresAt)]).toEqual(['member', 90]);
    expect(await listed(admin.plaintext, made.keyId)).toMatchObject({ role: 'member', expiresAt: made.expiresAt });
    expect((await send('GET', '/v1/memories?q=deploy', made.plaintext)).status).toBe(200);
    expect((await send('GET', '/v1/quarantine', made.plaintext)).status).toBe(403);
    expect((await mintOver(made.plaintext, {})).status).toBe(403);
  });

  it('a key minted with the default expiry works on day 89 and is refused on day 91', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const admin = hostMint('admin');
    const made = await jsonOf<Minted>(await mintOver(admin.plaintext, {}));
    expect((await send('GET', '/v1/memories?q=deploy', made.plaintext)).status).toBe(200);
    vi.setSystemTime(start + 89 * DAY_MS);
    expect((await send('GET', '/v1/memories?q=deploy', made.plaintext)).status).toBe(200);
    vi.setSystemTime(start + 91 * DAY_MS);
    const late = await send('GET', '/v1/memories?q=deploy', made.plaintext);
    expect([late.status, await jsonOf<{ error: string }>(late)]).toEqual([401, { error: 'invalid api key' }]);
    expect((await send('GET', '/v1/quarantine', admin.plaintext)).status).toBe(200);
  });

  it('admin and no expiry are each given only when the body names them', async () => {
    const admin = hostMint('admin');
    const asks: Array<[MintBody, string, number]> = [
      [{ role: 'admin' }, 'admin', 90],
      [{ noExpiry: true }, 'member', Number.NaN],
      [{ role: 'admin', noExpiry: true }, 'admin', Number.NaN],
      [{ ttlDays: 7 }, 'member', 7],
      [{ role: 'member', ttlDays: 3650, noExpiry: false }, 'member', 3650],
    ];
    for (const [body, role, days] of asks) {
      const made = await jsonOf<Minted>(await mintOver(admin.plaintext, body));
      expect([body, made.role, daysUntil(made.expiresAt)]).toEqual([body, role, days]);
      expect([body, await listed(admin.plaintext, made.keyId)]).toEqual([body, expect.objectContaining({ role, expiresAt: made.expiresAt })]);
    }
  });

  it('refuses an expiry it cannot honour with a 400 and mints nothing', async () => {
    const admin = hostMint('admin');
    const refusals: Array<[MintBody, string]> = [
      [{ ttlDays: 7, noExpiry: true }, 'send ttlDays or noExpiry, not both'],
      [{ ttlDays: 0 }, 'ttlDays must be above 0 and at most 3650'],
      [{ ttlDays: -1 }, 'ttlDays must be above 0 and at most 3650'],
      [{ ttlDays: 3651 }, 'ttlDays must be above 0 and at most 3650'],
      [{ ttlDays: '7' }, 'ttlDays must be a number'],
      [{ ttlDays: null }, 'ttlDays must be a number'],
      [{ noExpiry: null }, 'noExpiry must be true or false'],
      [{ noExpiry: 'yes' }, 'noExpiry must be true or false'],
    ];
    for (const [body, error] of refusals) {
      const res = await mintOver(admin.plaintext, body);
      expect([body, res.status, await jsonOf<{ error: string }>(res)]).toEqual([body, 400, { error }]);
    }
    const keys = await jsonOf<ListedKey[]>(await send('GET', '/v1/auth/keys?active=false', admin.plaintext));
    expect(keys.map((k) => k.keyId)).toEqual([admin.keyId]);
  });

  it('writes the expiry into the audit row of the mint, null for a key that never expires', async () => {
    const admin = hostMint('admin');
    const expiring = await jsonOf<Minted>(await mintOver(admin.plaintext, { label: 'ci' }));
    const forever = await jsonOf<Minted>(await mintOver(admin.plaintext, { label: 'ops', role: 'admin', noExpiry: true }));
    const rows = await jsonOf<AuditRow[]>(await send('GET', '/v1/audit?op=auth_create', admin.plaintext));
    const metadataOf = (keyId: string): AuditRow['metadata'] | undefined => rows.find((r) => r.targetId === keyId)?.metadata;
    expect(metadataOf(expiring.keyId)).toEqual({ label: 'ci', role: 'member', expiresAt: expiring.expiresAt });
    expect(metadataOf(forever.keyId)).toEqual({ label: 'ops', role: 'admin', expiresAt: null });
  });

  it('the first default mint raises the binary floor to the release that honours an expiry; a key that never expires leaves it', async () => {
    const admin = hostMint('admin');
    await mintOver(admin.plaintext, { noExpiry: true });
    expect(floor()).toBe('1.24.0');
    await mintOver(admin.plaintext, {});
    expect(floor()).toBe(EXPIRING_KEYS_MIN_BINARY);
  });
});

describe('hippo auth create defaults', () => {
  const create = (flags: Record<string, string | boolean>) => runInProcess(() => handleAuth({ hippoRoot: home, tenantId: 'default', args: ['create'], flags }));

  it('prints the role and the expiry date, and says on stderr which defaults it took and how to ask for an admin key', async () => {
    const run = await create({});
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^role: {6}member$/m);
    const expires = /^expires: {3}(\S+)$/m.exec(run.stdout)?.[1] ?? null;
    expect(daysUntil(expires)).toBe(90);
    expect(run.stderr).toBe('hippo auth create: no --role given, so this is a member key (pass --role admin for an admin key); no --ttl-days or --no-expiry given, so it expires in 90 days.\n');
    const plaintext = /^plaintext: (\S+)$/m.exec(run.stdout)?.[1] ?? '';
    expect(run.stderr).not.toContain(plaintext);
    expect((await send('GET', '/v1/quarantine', plaintext)).status).toBe(403);
  });

  it('mints an admin key that never expires when both are asked for, and then has nothing to add on stderr', async () => {
    const run = await create({ role: 'admin', 'no-expiry': true });
    expect([run.status, run.stderr]).toEqual([0, '']);
    expect(run.stdout).toMatch(/^role: {6}admin$/m);
    expect(run.stdout).toMatch(/^expires: {3}never$/m);
  });

  it('names only the default it took', async () => {
    const roleOnly = await create({ role: 'admin' });
    expect(roleOnly.stderr).toBe('hippo auth create: no --ttl-days or --no-expiry given, so it expires in 90 days.\n');
    const expiryOnly = await create({ 'ttl-days': '7' });
    expect(expiryOnly.stderr).toBe('hippo auth create: no --role given, so this is a member key (pass --role admin for an admin key).\n');
  });

  it('--json carries role and expiresAt', async () => {
    const run = await create({ json: true, 'ttl-days': '7' });
    // SAFETY: --json prints one object with these fields.
    const out = JSON.parse(run.stdout) as Minted;
    expect([out.role, daysUntil(out.expiresAt)]).toEqual(['member', 7]);
    // SAFETY: as above.
    const forever = JSON.parse((await create({ json: true, 'no-expiry': true })).stdout) as Minted;
    expect(forever.expiresAt).toBeNull();
  });

  it('refuses --ttl-days with --no-expiry, and a lifetime out of range, with exit 1 and no key', async () => {
    const both = await create({ 'ttl-days': '7', 'no-expiry': true });
    expect([both.status, both.stdout]).toEqual([1, '']);
    expect(both.stderr).toContain('send ttlDays or noExpiry, not both (--ttl-days, --no-expiry)');
    const zero = await create({ 'ttl-days': '0' });
    expect([zero.status, zero.stdout]).toEqual([1, '']);
    expect(zero.stderr).toContain('ttlDays must be above 0 and at most 3650');
    const admin = hostMint('admin');
    const keys = await jsonOf<ListedKey[]>(await send('GET', '/v1/auth/keys?active=false', admin.plaintext));
    expect(keys.map((k) => k.keyId)).toEqual([admin.keyId]);
  });

  it('the spawned CLI parses --ttl-days and --no-expiry, and refuses a lifetime that is not a number', () => {
    const env = { ...process.env, HIPPO_HOME: home };
    const week = hippoRun(['auth', 'create', '--global', '--json', '--ttl-days', '7'], { env, cwd: home });
    // SAFETY: --json prints one object with these fields.
    expect(daysUntil((JSON.parse(week.stdout) as Minted).expiresAt)).toBe(7);
    const forever = hippoRun(['auth', 'create', '--global', '--json', '--role', 'admin', '--no-expiry'], { env, cwd: home });
    // SAFETY: as above.
    expect(JSON.parse(forever.stdout) as Minted).toMatchObject({ role: 'admin', expiresAt: null });
    expect(forever.stderr).not.toContain('unknown flag');
    const soon = hippoRun(['auth', 'create', '--global', '--ttl-days', 'soon'], { env, cwd: home });
    expect([soon.status, soon.stdout, soon.stderr.trim()]).toEqual([1, '', '--ttl-days requires a numeric value.']);
  });
});

describe('the first key of a store', () => {
  it('a store with no key and required auth is administered from the host CLI: it mints the first admin key with no key of its own', async () => {
    const before = await fetch(`${handle.url}/v1/quarantine`);
    expect(before.status).toBe(401);
    const run = await runInProcess(() => handleAuth({ hippoRoot: home, tenantId: 'default', args: ['create'], flags: { role: 'admin', json: true } }));
    // SAFETY: --json prints one object with these fields.
    const first = JSON.parse(run.stdout) as Minted;
    expect([first.role, daysUntil(first.expiresAt)]).toEqual(['admin', 90]);
    expect((await send('GET', '/v1/quarantine', first.plaintext)).status).toBe(200);
    expect((await mintOver(first.plaintext, {})).status).toBe(200);
  });

  it('gets no wider role for being first: with no role named it is a member key', async () => {
    const run = await runInProcess(() => handleAuth({ hippoRoot: home, tenantId: 'default', args: ['create'], flags: { json: true } }));
    // SAFETY: --json prints one object with these fields.
    const first = JSON.parse(run.stdout) as Minted;
    expect(first.role).toBe('member');
    expect((await send('GET', '/v1/quarantine', first.plaintext)).status).toBe(403);
  });
});
