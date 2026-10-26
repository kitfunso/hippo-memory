// On/off variables share one reader: unknown spellings take the safe side, and serve refuses to boot on them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { ServerHandle } from '../../src/server.js';
import { serve } from '../_helpers/store-switch.js';
import {
  envAblateDecay,
  envAllowCleartext,
  envRuntimeSettings,
  validateFlags,
} from '../../src/base/util/env.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const KEYS = ['HIPPO_ALLOW_CLEARTEXT', 'HIPPO_ABLATE_DECAY', 'HIPPO_AUTODEBIAS'] as const;

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
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', 'yes');
    expect(envAllowCleartext()).toBe(false);
    expect(validateFlags()).toEqual(['HIPPO_ALLOW_CLEARTEXT="yes"']);
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

  it('refuses to boot on HIPPO_ALLOW_CLEARTEXT=yes and names the variable', async () => {
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', 'yes');
    await expect(serve({ hippoRoot: home, port: 0, host: '127.0.0.1' })).rejects.toThrow(
      /HIPPO_ALLOW_CLEARTEXT/,
    );
  });

  it('answers a keyless request 401 whatever the removed keyless switches say', async () => {
    vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
    handle = await serve({ hippoRoot: home, port: 0, host: '127.0.0.1' });
    const res = await fetch(`${handle.url}/v1/memories?q=deploy`);
    expect(res.status).toBe(401);
  });
});
