// Under a store other than hippo.db, MCP lists and runs only the tools that reach their store through the port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetSharedStoreCacheForTests } from '../src/config.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/http-util.js';
import { handleMcpRequest, type McpContext, type McpResponse } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { serve, type HippoStore, type MemoryEntry, type ServerHandle } from '../src/server.js';
import { sqliteStore } from '../src/store-port.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { predictionMirror } from '../src/store/predictions.js';
import { inMemoryDagReadsStore } from './_helpers/in-memory-dag-reads-store.js';
import { inMemoryPredictionsStore } from './_helpers/in-memory-predictions-store.js';
import { portOnlyStore } from './_helpers/port-only-store.js';
import { CLEARED_ENV, seeded } from './_helpers/recall-golden-seed.js';
import { seedTwoTenants, TENANT_A, TENANT_B, type TwoTenantFixture } from './_helpers/store-conformance.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-mcp-ready-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The stub kind wraps a hippo.db store that nothing blocks, so a tool that ran would leave hippo.db behind.
const ctxOn = (kind: string | undefined): McpContext => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: 'mcp',
  store: kind === undefined ? undefined : { ...sqliteStore(root), kind },
});

// An add-on store built before the contextReads group.
const ctxWithoutContextReads = (): McpContext => ({ hippoRoot: root, tenantId: 'default', actor: 'mcp', store: portOnlyStore(root) });

function listedNames(res: McpResponse | null): string[] {
  // SAFETY: src/mcp/request.ts answers tools/list with { tools: McpToolDefinition[] }.
  const result = res?.result as { tools: { name: string }[] } | undefined;
  return result?.tools.map((t) => t.name) ?? [];
}

const declared = TOOLS.map((t) => t.name);
const notPorted = { jsonrpc: '2.0', id: 1, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
// The stub carries every group sqliteStore sets, so the tools that name one run on it.
const READY = ['hippo_recall', 'hippo_assemble', 'hippo_drill', 'hippo_predict_baserate', 'hippo_remember', 'hippo_outcome', 'hippo_context'];
const ready = declared.filter((name) => READY.includes(name));

describe('store-ready MCP tools', () => {
  it('tools/list under another store lists only the tools that name a group it has', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn('stub'));
    expect(listedNames(res)).toEqual(ready);
  });

  it('tools/list under a store without contextReads leaves hippo_context out, and a call to it answers store_not_ported', async () => {
    const listed = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxWithoutContextReads());
    expect(listedNames(listed)).toEqual(['hippo_recall']);
    const called = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_context', arguments: {} } }, ctxWithoutContextReads(),
    );
    expect(called).toEqual(notPorted);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([['the sqlite store', 'sqlite'], ['a context with no store', undefined]] as const)('tools/list on %s lists every tool', async (_name, kind) => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOn(kind));
    expect(listedNames(res)).toEqual(declared);
  });

  it('a call to any other tool under another store answers store_not_ported, and the tool never runs', async () => {
    const unready = declared.filter((name) => !ready.includes(name));
    expect(unready.length).toBeGreaterThan(0);
    for (const name of unready) {
      const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, ctxOn('stub'));
      expect(res).toEqual(notPorted);
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

const PROJECT = 'proj';
const note = (id: string): string => `${id} holds a note about the rollout`;
const minute = (m: number): string => `2026-03-01T10:0${m}:00.000Z`;
const row = (tenantId: string, id: string, m: number, extra: Partial<MemoryEntry>): MemoryEntry =>
  seeded(note(id), id, minute(m), { tenantId, origin_project: PROJECT, ...extra });
const raw = (tenantId: string, id: string, m: number): MemoryEntry => row(tenantId, id, m, { kind: 'raw', source_session_id: 'sess-mcp' });

// serve() blocks hippo.db for a store of another kind, so a tool that still opened it would answer store_not_ported here.
describe('POST /mcp on a caller-supplied store, with hippo.db blocked', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    for (const k of CLEARED_ENV) vi.stubEnv(k, '');
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_HOME', join(root, 'global'));
    _resetSharedStoreCacheForTests();
    fixture = seedTwoTenants();
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
    _resetSharedStoreCacheForTests();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  /** The tool's text over POST /mcp as that key, or the whole reply as JSON when it carries no text. */
  async function callServed(store: HippoStore, token: string, name: string, args: Record<string, string>): Promise<string> {
    handle ??= await serve({ hippoRoot: fixture.dir, port: 0, store });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-hippo-project': PROJECT };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = await fetch(`${handle.url}/mcp`, { method: 'POST', headers, body });
    // SAFETY: a tools/call reply is JSON; a text reply carries result.content[0].text.
    const reply = await res.json() as { result?: { content?: { text?: string }[] } };
    return reply.result?.content?.[0]?.text ?? JSON.stringify(reply);
  }

  it('hippo_predict_baserate reads the store\'s closed rows inside the caller\'s tenant and leaves its audit row there', async () => {
    const memory = inMemoryPredictionsStore(fixture.dir);
    const claim = { classTag: 'cutover', claimText: 'the cutover takes two days', estimateValue: 2 };
    const saved = await memory.store.predictions.savePrediction(TENANT_A, { ...claim, mirror: predictionMirror(TENANT_A, claim, 30) }, 'seed');
    await memory.store.predictions.closePrediction(TENANT_A, saved.id, { closureState: 'closed', actualValue: 3 }, 'seed');
    const { memberA, memberB } = fixture.tokens;
    expect(await callServed(memory.store, memberA, 'hippo_predict_baserate', { class_tag: 'cutover' })).toBe([
      'Last 1 estimate in class cutover averaged 1.50x actual (MAE 1.00).',
      '',
      'n_closed:         1',
      'n_ratio_eligible: 1',
      'mean_estimate:    2.000',
      'mean_actual:      3.000',
      'mean_ratio:       1.500x',
      'p50_ratio:        1.500x',
      'mae:              1.000',
    ].join('\n'));
    expect(await callServed(memory.store, memberB, 'hippo_predict_baserate', { class_tag: 'cutover' })).toMatch(/^No closed predictions in class "cutover" yet\./);
    expect(memory.auditRows().slice(-2).map((e) => [e.op, e.actor, e.tenantId, e.targetId, e.metadata])).toEqual([
      ['predict_baserate', `api_key:${fixture.keys.memberA}`, TENANT_A, 'cutover', { class_tag: 'cutover', n_closed: 1 }],
      ['predict_baserate', `api_key:${fixture.keys.memberB}`, TENANT_B, 'cutover', { class_tag: 'cutover', n_closed: 0 }],
    ]);
  });

  it('hippo_assemble builds the window from the store\'s rows, without a row only hippo.db holds', async () => {
    for (const entry of [raw(TENANT_A, 'raw_1', 1), raw(TENANT_A, 'raw_2', 2), raw(TENANT_A, 'raw_3', 3), raw(TENANT_B, 'raw_b', 2)]) writeEntry(fixture.dir, entry);
    const { store } = inMemoryDagReadsStore(fixture.dir);
    writeEntry(fixture.dir, raw(TENANT_A, 'raw_late', 4));
    const text = await callServed(store, fixture.tokens.memberA, 'hippo_assemble', { session_id: 'sess-mcp' });
    const [heading, ...lines] = text.split('\n');
    expect(heading).toMatch(/^Session sess-mcp \u2014 3 items, \d+ tokens \(raw=3, summarized=0, evicted=0\)$/);
    expect(lines).toEqual([1, 2, 3].map((m) => `  [tail] ${minute(m)} raw_${m} - ${note(`raw_${m}`)}`));
  });

  it('hippo_drill lists the store\'s children of a summary, without a child only hippo.db holds', async () => {
    const child = (tenantId: string, id: string, m: number): MemoryEntry => row(tenantId, id, m, { dag_parent_id: 'sum_1', dag_level: 1 });
    for (const entry of [row(TENANT_A, 'sum_1', 5, { dag_level: 2, descendant_count: 2 }), child(TENANT_A, 'fact_1', 1), child(TENANT_A, 'fact_2', 2), child(TENANT_B, 'fact_b', 3)]) {
      writeEntry(fixture.dir, entry);
    }
    const { store } = inMemoryDagReadsStore(fixture.dir);
    writeEntry(fixture.dir, child(TENANT_A, 'fact_late', 4));
    expect(await callServed(store, fixture.tokens.memberA, 'hippo_drill', { summary_id: 'sum_1' })).toBe([
      'Summary sum_1 \u2014 2 descendants',
      `  ${note('sum_1')}`,
      '',
      'Children (2/2):',
      `  [L1] fact_1 - ${note('fact_1')}`,
      `  [L1] fact_2 - ${note('fact_2')}`,
    ].join('\n'));
    expect(await callServed(store, fixture.tokens.memberB, 'hippo_drill', { summary_id: 'sum_1' })).toBe('No drillable summary at id=sum_1.');
  });
});
