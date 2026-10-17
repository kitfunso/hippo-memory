// On/off variables share one reader: unknown spellings take the safe side, and serve refuses to boot on them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { serve, type ServerHandle } from '../src/server.js';
import {
  envAblateDecay,
  envAllowKeylessLocal,
  envAutodebiasOff,
  envRequireAuth,
  validateFlags,
} from '../src/util/env.js';
import { makeRoot } from './_helpers/make-root.js';

const KEYS = ['HIPPO_ALLOW_KEYLESS_LOCAL', 'HIPPO_REQUIRE_AUTH', 'HIPPO_ABLATE_DECAY', 'HIPPO_AUTODEBIAS'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('flag spellings', () => {
  it.each(['1', 'true', 'TRUE', ' on '])('reads %j as on', (value) => {
    process.env.HIPPO_ABLATE_DECAY = value;
    expect(envAblateDecay()).toBe(true);
  });

  it.each(['', '0', 'false', 'off'])('reads %j as off', (value) => {
    process.env.HIPPO_ABLATE_DECAY = value;
    expect(envAblateDecay()).toBe(false);
    expect(validateFlags()).toEqual([]);
  });

  it('keeps HIPPO_AUTODEBIAS=off meaning the hint is off', () => {
    expect(envAutodebiasOff()).toBe(false);
    process.env.HIPPO_AUTODEBIAS = 'off';
    expect(envAutodebiasOff()).toBe(true);
  });

  it('takes the safe side of an unknown spelling without throwing', () => {
    process.env.HIPPO_REQUIRE_AUTH = 'yes';
    process.env.HIPPO_ALLOW_KEYLESS_LOCAL = 'yes';
    expect(envRequireAuth()).toBe(true);
    expect(envAllowKeylessLocal()).toBe(false);
    expect(validateFlags()).toEqual(['HIPPO_REQUIRE_AUTH="yes"', 'HIPPO_ALLOW_KEYLESS_LOCAL="yes"']);
  });
});

describe('serve with flags', () => {
  let home: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    home = makeRoot('flags-fail-closed');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to boot on HIPPO_REQUIRE_AUTH=yes and names the variable', async () => {
    process.env.HIPPO_REQUIRE_AUTH = 'yes';
    await expect(serve({ hippoRoot: home, port: 0, host: '127.0.0.1' })).rejects.toThrow(/HIPPO_REQUIRE_AUTH/);
  });

  it('answers a keyless request 401 when ALLOW_KEYLESS_LOCAL=1 and REQUIRE_AUTH=true', async () => {
    process.env.HIPPO_ALLOW_KEYLESS_LOCAL = '1';
    process.env.HIPPO_REQUIRE_AUTH = 'true';
    handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`);
    expect(res.status).toBe(401);
  });
});
