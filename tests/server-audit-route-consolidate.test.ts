/**
 * Runtime test for v1.11.5: round-trip a consolidate audit_log row through
 * GET /v1/audit?op=consolidate.
 *
 * Locks the VALID_AUDIT_OPS Set wiring: adding 'consolidate' to the AuditOp
 * union at audit.ts WITHOUT adding it to the Set at server.ts:70 would let
 * api.sleep write rows that GET /v1/audit?op=consolidate rejects with HTTP
 * 400 "invalid op". This test fails if the Set drifts from the union.
 *
 * Also incidentally covers the pre-existing 'outcome' drift the round-3
 * critic surfaced (audit.ts had it, the Set didn't) — included for the
 * same reason.
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember, sleep, outcome, type Context } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-audit-route-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('GET /v1/audit?op=<op> — consolidate + outcome wiring', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('round-trips a consolidate row written by api.sleep', async () => {
    // Seed: write one row by invoking api.sleep, then query via HTTP.
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    remember(ctx, { content: 'seed-for-consolidate' });
    await sleep(ctx, { dryRun: true });

    const res = await fetch(`${handle.url}/v1/audit?op=consolidate`);
    expect(res.status).toBe(200);
    // auditList returns AuditEvent[] directly (not {events: [...]}).
    const body = await res.json() as Array<{ op: string; actor: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((e) => e.op === 'consolidate')).toBe(true);
  });

  it('round-trips an outcome row (pre-existing drift the v1.11.5 Set update closes)', async () => {
    const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
    const m1 = remember(ctx, { content: 'outcome-target' });
    outcome(ctx, [m1.id], true);

    const res = await fetch(`${handle.url}/v1/audit?op=outcome`);
    // Pre-v1.11.5 this returned 400 'invalid op' even though rows existed.
    // Post-v1.11.5 it returns 200 with the rows.
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ op: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((e) => e.op === 'outcome')).toBe(true);
  });

  it('rejects unknown ops with 400 (sanity check on the Set filter still works)', async () => {
    const res = await fetch(`${handle.url}/v1/audit?op=nonexistent_op`);
    expect(res.status).toBe(400);
  });
});
