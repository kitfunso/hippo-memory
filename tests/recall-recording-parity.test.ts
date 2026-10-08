// One recall on the CLI and one on HTTP, over equal stores, leave the same record apart from each surface's label:
// on a plain recall, and when the store refuses the recall's audit row, where both must leave none.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeEntry } from '../src/store/entry-writes.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { cmdRecall, __resetSessionRecallHistoryCli } from '../src/cli/recall.js';
import { serve, __resetSessionRecallHistoryHttp } from '../src/server.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess, type InProcessResult } from './_helpers/run-in-process.js';
import { CLEARED_ENV, seeded } from './_helpers/recall-golden-seed.js';

const QUERY = 'harrowfen';
const MATCHING = ['mem_r_one', 'mem_r_three', 'mem_r_two'];

function equalStore(label: string): string {
  const root = makeRoot(label);
  writeEntry(root, seeded('the harrowfen pump runs at night', 'mem_r_one', '2026-01-10T00:00:00.000Z'));
  writeEntry(root, seeded('harrowfen valve spares live in the east shed', 'mem_r_two', '2026-01-11T00:00:00.000Z'));
  writeEntry(root, seeded('call the harrowfen duty engineer before a restart', 'mem_r_three', '2026-01-12T00:00:00.000Z'));
  writeEntry(root, seeded('lunch options near the office', 'mem_r_noise', '2026-01-13T00:00:00.000Z'));
  return root;
}

function rows(root: string, sql: string): unknown[] {
  const db = openHippoDb(root);
  try {
    return db.prepare(sql).all();
  } finally {
    closeHippoDb(db);
  }
}

/** What a recall records, without the columns that name the surface (actor, pipeline) or hold its own ranker's score. */
function recorded(root: string) {
  return {
    audit: rows(root, "SELECT tenant_id, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'recall%' ORDER BY id"),
    traces: rows(root, 'SELECT tenant_id, session_id, result_count, explain_mode FROM recall_traces ORDER BY id'),
    traced: rows(root, 'SELECT memory_id FROM recall_trace_results ORDER BY memory_id'),
    strengthened: rows(root, 'SELECT id, retrieval_count FROM memories WHERE retrieval_count > 0 ORDER BY id'),
    counted: rows(root, "SELECT value FROM meta WHERE key = 'total_recalled'"),
  };
}

/** The ledger row without its surface and token count: each surface books the size of the text it sent. */
function ledger(root: string): unknown[] {
  return rows(root, 'SELECT tenant_id, session_id, event, items FROM token_ledger ORDER BY id');
}

function labels(root: string) {
  return {
    actors: rows(root, "SELECT DISTINCT actor FROM audit_log WHERE op LIKE 'recall%'"),
    pipelines: rows(root, 'SELECT DISTINCT pipeline FROM recall_traces'),
    surfaces: rows(root, 'SELECT DISTINCT surface FROM token_ledger'),
  };
}

function refuseRecallAudit(root: string): void {
  const db = openHippoDb(root);
  try {
    db.exec("CREATE TRIGGER refuse_recall_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'recall' BEGIN SELECT RAISE(ABORT, 'recall audit refused'); END");
  } finally {
    closeHippoDb(db);
  }
}

function viaCli(root: string): Promise<InProcessResult> {
  return runInProcess(() => cmdRecall(root, QUERY, {}));
}

async function viaHttp(root: string): Promise<number> {
  const handle = await serve({ hippoRoot: root, port: 0 });
  try {
    const res = await fetch(`${handle.url}/v1/memories?${new URLSearchParams({ q: QUERY }).toString()}`);
    await res.text();
    return res.status;
  } finally {
    await handle.stop();
  }
}

describe('recall recording parity, CLI against HTTP', () => {
  let cliRoot: string;
  let httpRoot: string;

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    _resetAblationCacheForTests();
    __resetSessionRecallHistoryCli();
    __resetSessionRecallHistoryHttp();
    cliRoot = equalStore('record-cli');
    httpRoot = equalStore('record-http');
    // No global store, so the CLI searches the one store HTTP does.
    vi.stubEnv('HIPPO_HOME', join(cliRoot, 'no-global-store'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetAblationCacheForTests();
    for (const root of [cliRoot, httpRoot]) rmSync(root, { recursive: true, force: true });
  });

  it('a plain recall leaves the same rows on both surfaces, apart from the label', async () => {
    expect((await viaCli(cliRoot)).status).toBe(0);
    expect(await viaHttp(httpRoot)).toBe(200);

    const cli = recorded(cliRoot);
    expect(cli.strengthened).toEqual(MATCHING.map((id) => ({ id, retrieval_count: 1 })));
    expect(cli.audit).toHaveLength(2);
    expect(cli.traces).toHaveLength(1);
    expect(cli).toEqual(recorded(httpRoot));
    expect(ledger(cliRoot)).toEqual([{ tenant_id: 'default', session_id: null, event: 'inject', items: 3 }]);
    expect(ledger(cliRoot)).toEqual(ledger(httpRoot));

    expect(labels(cliRoot)).toEqual({ actors: [{ actor: 'cli' }], pipelines: [{ pipeline: 'cli' }], surfaces: [{ surface: 'recall' }] });
    expect(labels(httpRoot)).toEqual({ actors: [{ actor: 'localhost:cli' }], pipelines: [{ pipeline: 'api' }], surfaces: [{ surface: 'http_recall' }] });
  }, 60_000);

  it('a recall whose audit row the store refuses leaves the same rows on both surfaces: none', async () => {
    refuseRecallAudit(cliRoot);
    refuseRecallAudit(httpRoot);

    // The CLI has ranked and prints; HTTP answers 500. Neither may keep a hint row, a trace, a strengthen or a count.
    const cli = await viaCli(cliRoot);
    expect(cli.status).toBe(0);
    for (const id of MATCHING) expect(cli.stdout).toContain(id);
    expect(cli.stderr).toContain('audit write failed');
    expect(await viaHttp(httpRoot)).toBe(500);

    const nothing = { audit: [], traces: [], traced: [], strengthened: [], counted: [{ value: '0' }] };
    expect(recorded(cliRoot)).toEqual(nothing);
    expect(recorded(httpRoot)).toEqual(nothing);
    // The ledger books text that was sent: the CLI printed its block, HTTP sent no memory.
    expect(ledger(cliRoot)).toEqual([{ tenant_id: 'default', session_id: null, event: 'inject', items: 3 }]);
    expect(ledger(httpRoot)).toEqual([]);
  }, 60_000);
});
