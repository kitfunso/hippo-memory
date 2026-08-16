/**
 * J3.2 — HTTP wire-format for planningFallacyHint on /v1/memories.
 *
 * Asserts the optional planningFallacyHint field rides on the GET
 * /v1/memories response body in camelCase shape, present only when the
 * query matches and a class resolves.
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 6, Task 9).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { savePrediction, closePrediction } from '../src/predictions.js';
import type { RecallResult } from '../src/api.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-j32-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function seedBaserate(home: string): void {
  for (const [est, act] of [[2, 4], [3, 6], [4, 8]]) {
    const p = savePrediction(home, 'default', {
      classTag: 'migration-effort',
      claimText: `migration effort ${est} days`,
      estimateValue: est,
    });
    closePrediction(home, 'default', p.id, { closureState: 'closed', actualValue: act });
  }
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  delete process.env.HIPPO_AUTODEBIAS;
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
  delete process.env.HIPPO_AUTODEBIAS;
});

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: T is pinned by each call site to Partial<RecallResult> (the
  // /v1/memories response envelope defined in src/api.ts); every call site
  // asserts the specific fields it reads immediately after this call.
  return res.json() as Promise<T>;
}

describe('HTTP /v1/memories planningFallacyHint (J3.2 v0.32)', () => {
  it('response includes planningFallacyHint with camelCase shape when query matches', async () => {
    seedBaserate(home);
    const q = encodeURIComponent('migration effort will take 3 days');
    const res = await fetch(`${handle.url}/v1/memories?q=${q}`);
    expect(res.status).toBe(200);
    const body = await jsonAs<Partial<RecallResult>>(res);
    expect(body.planningFallacyHint).toBeDefined();
    const { planningFallacyHint: hint } = body;
    if (hint === undefined) {
      throw new Error('unreachable: expect(body.planningFallacyHint).toBeDefined() above guarantees this');
    }
    // Wire-shape: camelCase fields per _Base.alias_generator=to_camel parity.
    expect(hint.classTag).toBe('migration-effort');
    expect(hint.source).toBe('j3.2-auto');
    expect(hint.nClosed).toBe(3);
    expect(hint.detectedPhrase).toEqual(expect.any(String));
    expect(hint.baserateSummary).toEqual(expect.any(String));
  });

  it('planningFallacyHint absent when query has no forward-claim phrase', async () => {
    seedBaserate(home);
    const q = encodeURIComponent('show me the auth flow');
    const res = await fetch(`${handle.url}/v1/memories?q=${q}`);
    const body = await jsonAs<Partial<RecallResult>>(res);
    expect(body.planningFallacyHint).toBeUndefined();
  });

  it('planningFallacyHint absent when HIPPO_AUTODEBIAS=off', async () => {
    seedBaserate(home);
    process.env.HIPPO_AUTODEBIAS = 'off';
    const q = encodeURIComponent('migration effort will take 3 days');
    const res = await fetch(`${handle.url}/v1/memories?q=${q}`);
    const body = await jsonAs<Partial<RecallResult>>(res);
    expect(body.planningFallacyHint).toBeUndefined();
  });
});
