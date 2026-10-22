// On/off variables share one reader: unknown spellings take the safe side, and serve refuses to boot on them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import {
  envAblateDecay,
  envAllowKeylessLocal,
  envRequireAuth,
  envRuntimeSettings,
  validateFlags,
} from '../../src/base/util/env.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEYS = ['HIPPO_ALLOW_KEYLESS_LOCAL', 'HIPPO_REQUIRE_AUTH', 'HIPPO_ABLATE_DECAY', 'HIPPO_AUTODEBIAS'] as const;

beforeEach(() => {
  for (const key of KEYS) vi.stubEnv(key, undefined);
});

describe('flag spellings', () => {
  it.each(['1', 'true', 'TRUE', ' on '])('reads %j as on', (value) => {
    vi.stubEnv('HIPPO_ABLATE_DECAY', value);
    expect(envAblateDecay()).toBe(true);
  });

  it.each(['', '0', 'false', 'off'])('reads %j as off', (value) => {
    vi.stubEnv('HIPPO_ABLATE_DECAY', value);
    expect(envAblateDecay()).toBe(false);
    expect(validateFlags()).toEqual([]);
  });

  it('keeps HIPPO_AUTODEBIAS=off meaning the hint is off', () => {
    expect(envRuntimeSettings().autodebias).toBe(true);
    vi.stubEnv('HIPPO_AUTODEBIAS', 'off');
    expect(envRuntimeSettings().autodebias).toBe(false);
  });

  it('takes the safe side of an unknown spelling without throwing', () => {
    vi.stubEnv('HIPPO_REQUIRE_AUTH', 'yes');
    vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', 'yes');
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
    vi.stubEnv('HIPPO_REQUIRE_AUTH', 'yes');
    await expect(serve({ hippoRoot: home, port: 0, host: '127.0.0.1' })).rejects.toThrow(/HIPPO_REQUIRE_AUTH/);
  });

  it('answers a keyless request 401 when ALLOW_KEYLESS_LOCAL=1 and REQUIRE_AUTH=true', async () => {
    vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
    vi.stubEnv('HIPPO_REQUIRE_AUTH', 'true');
    handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`);
    expect(res.status).toBe(401);
  });
});
