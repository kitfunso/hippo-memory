// Sleep never builds a new memory from a superseded one, so an old claim cannot come back as a current row.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, Layer } from '../src/memory.js';
import { initStore, writeEntry, loadAllEntries, loadChildrenOfSummary, loadAllL2Summaries } from '../src/store.js';
import { consolidate } from '../src/consolidate.js';
import { supersede, type Context } from '../src/api.js';

const DAY = 86_400_000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hippo-sleep-superseded-'));
  roots.push(root);
  initStore(root);
  return root;
}

const ctxFor = (hippoRoot: string): Context =>
  ({ hippoRoot, tenantId: 'default', actor: { subject: 'sleep-superseded-test', role: 'admin' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('sleep skips superseded rows', () => {
  it('as merge, fact extraction and DAG build input', async () => {
    const root = newRoot();
    const blamed = createMemory('the march outage postmortem blamed bob for dropping the billing table in production');
    writeEntry(root, blamed);
    for (const text of ['the march outage postmortem blamed the dropped billing table', 'the march outage postmortem blamed the dropped billing table in production']) {
      writeEntry(root, createMemory(text));
    }
    const facts = ['alice moved the deploy to friday', 'alice owns the billing service', 'alice reviews every schema change', 'alice owns the oldfact payroll service']
      .map((text) => createMemory(text, { layer: Layer.Semantic, dag_level: 1, tags: ['extracted', 'speaker:alice'] }));
    for (const f of facts) writeEntry(root, f);
    supersede(ctxFor(root), blamed.id, 'the march outage postmortem found no single person at fault');
    supersede(ctxFor(root), facts[3]!.id, 'bob owns the payroll service');
    const prompts: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      prompts.push(String(init?.body));
      return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('real network call in a test'); }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');

    await consolidate(root, { now: new Date(Date.now() + DAY), fetcher });

    const sent = prompts.join('\n');
    expect(sent).toContain('blamed the dropped billing table');
    expect(sent).toContain('alice reviews every schema change');
    expect(sent).not.toMatch(/blamed bob|oldfact/);
    const current = loadAllEntries(root).filter((e) => !e.superseded_by);
    expect(current.some((e) => e.content.startsWith('[Consolidated from 2 related memories]'))).toBe(true);
    expect(current.map((e) => e.content).join('\n')).not.toMatch(/blamed bob|oldfact/);
  });

  it('as DAG rebuild and L3 profile input', () => {
    const root = newRoot();
    const summary = createMemory('alice runs billing and payroll', { layer: Layer.Semantic, confidence: 'inferred', dag_level: 2, tags: ['dag-summary'] });
    writeEntry(root, summary);
    const [kept, stale] = ['alice runs billing', 'alice runs payroll']
      .map((text) => createMemory(text, { layer: Layer.Semantic, dag_level: 1, dag_parent_id: summary.id, tags: ['extracted'] }));
    writeEntry(root, kept!);
    writeEntry(root, stale!);
    supersede(ctxFor(root), stale!.id, 'bob runs payroll');

    expect(loadChildrenOfSummary(root, summary.id, 'default').map((e) => e.id)).toEqual([kept!.id]);
    expect(loadAllL2Summaries(root).map((e) => e.id)).toEqual([summary.id]);
    supersede(ctxFor(root), summary.id, 'alice runs billing and bob runs payroll');
    expect(loadAllL2Summaries(root)).toEqual([]);
  });
});
