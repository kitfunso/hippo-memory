/** EI2 T3/T6/T7: derived memories keep the source scope; briefs never quote a restricted receipt. */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  writeEntry,
  loadAllEntries,
  appendSessionEvent,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';
import { deduplicateStore } from '../src/dedupe.js';
import { buildDag, buildEntityProfiles } from '../src/dag.js';
import { storeExtractedFacts, type ExtractedFact } from '../src/extract.js';
import { saveProjectBrief, assembleBriefFromReceipts } from '../src/project-briefs.js';
import { derivationScope, commonDerivationScope } from '../src/recall-scope.js';

function tmpHome(prefix: string = 'hippo-derived-scope-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeOkFetcher(content: string) {
  return vi.fn<typeof fetch>(async () => new Response(
    JSON.stringify({ content: [{ text: content }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

describe('derivationScope / commonDerivationScope', () => {
  it('keeps a restricted scope, including a mixed-case one the JS regex alone would miss', () => {
    expect(derivationScope('slack:private:C1')).toBe('slack:private:C1');
    expect(derivationScope('Slack:Private:C1')).toBe('Slack:Private:C1');
  });

  it('drops an unrestricted scope to null', () => {
    expect(derivationScope('github:public:x')).toBeNull();
    expect(derivationScope(null)).toBeNull();
    expect(derivationScope(undefined)).toBeNull();
  });

  it('agrees on one scope shared by every source', () => {
    expect(commonDerivationScope(['slack:private:C1', 'slack:private:C1'])).toEqual({ ok: true, scope: 'slack:private:C1' });
    expect(commonDerivationScope([null, 'github:public:x'])).toEqual({ ok: true, scope: null });
  });

  it('rejects two sources that disagree', () => {
    expect(commonDerivationScope(['slack:private:C1', 'jira:private:P1'])).toEqual({ ok: false });
    expect(commonDerivationScope(['slack:private:C1', null])).toEqual({ ok: false });
  });
});

describe('T3: consolidate() merge pass partitions by scope', () => {
  it('a private-scope cluster merges into that scope; a same-tenant unscoped cluster never absorbs the private text', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');

      const backbone = 'rotate the staging tls certificates before expiry';
      const privShort = createMemory(backbone, { layer: Layer.Episodic, scope: 'slack:private:C1' });
      const privLong = createMemory(`${backbone} zzzprivatemarkerzzz notify the on-call channel`, {
        layer: Layer.Episodic,
        scope: 'slack:private:C1',
      });
      const pubShort = createMemory(backbone, { layer: Layer.Episodic, scope: null });
      const pubLong = createMemory(`${backbone} notify the on-call channel of the change`, {
        layer: Layer.Episodic,
        scope: null,
      });
      writeEntry(home, privShort);
      writeEntry(home, privLong);
      writeEntry(home, pubShort);
      writeEntry(home, pubLong);

      const result = await consolidate(home, { dryRun: false });

      expect(result.merged).toBe(4);
      expect(result.semanticCreated).toBe(2);

      const semantics = loadAllEntries(home).filter((e) => e.layer === Layer.Semantic);
      expect(semantics).toHaveLength(2);

      const privateSemantic = semantics.find((s) => s.scope === 'slack:private:C1');
      const nullSemantic = semantics.find((s) => s.scope === null);
      expect(privateSemantic).toBeDefined();
      expect(nullSemantic).toBeDefined();
      expect(privateSemantic!.content).toContain('zzzprivatemarkerzzz');
      expect(nullSemantic!.content).not.toContain('zzzprivatemarkerzzz');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('dedupe partitions by restricted scope', () => {
  it('a private near-duplicate never deletes the unrestricted copy', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const text = 'rotate the staging tls certificates before expiry and notify on-call';
      const priv = createMemory(text, { layer: Layer.Semantic, scope: 'slack:private:C1' });
      const pub = createMemory(text, { layer: Layer.Semantic, scope: null });
      writeEntry(home, { ...priv, strength: 0.9 });
      writeEntry(home, { ...pub, strength: 0.1 });

      expect(deduplicateStore(home).removed).toBe(0);
      expect(loadAllEntries(home).map((e) => e.scope).sort()).toEqual([null, 'slack:private:C1'].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T7: auto-promote stamps the session scope, or skips a mixed one', () => {
  it('a session whose events are all slack:private:C1 promotes a trace in that scope', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      const sid = 'sess-private-uniform';
      appendSessionEvent(home, 'default', {
        session_id: sid, event_type: 'action', content: 'read the private doc', source: 'agent', scope: 'slack:private:C1',
      });
      appendSessionEvent(home, 'default', {
        session_id: sid, event_type: 'session_complete', content: 'success', source: 'agent',
        scope: 'slack:private:C1', metadata: { summary: 'handled the private request' },
      });

      const result = await consolidate(home, { now: new Date() });
      expect(result.promotedTraces).toBe(1);
      expect(result.tracesSkippedMixedScope).toBe(0);

      const traces = loadAllEntries(home).filter((e) => e.layer === Layer.Trace);
      expect(traces).toHaveLength(1);
      expect(traces[0]!.scope).toBe('slack:private:C1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a session mixing a private scope with an unscoped event is skipped, not promoted', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      const sid = 'sess-mixed';
      appendSessionEvent(home, 'default', {
        session_id: sid, event_type: 'action', content: 'read the private doc', source: 'agent', scope: 'slack:private:C1',
      });
      appendSessionEvent(home, 'default', {
        session_id: sid, event_type: 'action', content: 'post the public update', source: 'agent', scope: null,
      });
      appendSessionEvent(home, 'default', {
        session_id: sid, event_type: 'session_complete', content: 'success', source: 'agent',
        metadata: { summary: 'mixed session' },
      });

      const result = await consolidate(home, { now: new Date() });
      expect(result.promotedTraces).toBe(0);
      expect(result.tracesSkippedMixedScope).toBe(1);

      const traces = loadAllEntries(home).filter((e) => e.layer === Layer.Trace);
      expect(traces).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T3: dag buildDag / buildEntityProfiles partition by scope', () => {
  it('buildDag never parents a private fact and a public fact under the same L2, and the private L2 carries the scope', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      const privFacts = ['alice filed X', 'alice noted Y', 'alice closed Z'].map((c) =>
        createMemory(c, { layer: Layer.Episodic, dag_level: 1, tags: ['extracted', 'speaker:alice'], scope: 'slack:private:C1' }),
      );
      const pubFacts = ['alice shipped P', 'alice reviewed Q', 'alice merged R'].map((c) =>
        createMemory(c, { layer: Layer.Episodic, dag_level: 1, tags: ['extracted', 'speaker:alice'], scope: null }),
      );
      for (const f of [...privFacts, ...pubFacts]) writeEntry(home, f);

      const fetcher = makeOkFetcher('synthetic-scope-partitioned-summary');
      const result = await buildDag(home, [...privFacts, ...pubFacts], { apiKey: 'test-key', fetcher });

      expect(result.candidateClusters).toBe(2);
      expect(result.summariesCreated).toBe(2);
      expect(result.factsLinked).toBe(6);

      const db = openHippoDb(home);
      try {
        // SAFETY: SELECT projects exactly id, scope; .all() returns rows in that shape.
        const l2s = db.prepare(`SELECT id, scope FROM memories WHERE dag_level = 2`).all() as Array<{ id: string; scope: string | null }>;
        expect(l2s).toHaveLength(2);
        const privateL2 = l2s.find((s) => s.scope === 'slack:private:C1');
        const publicL2 = l2s.find((s) => s.scope === null);
        expect(privateL2).toBeDefined();
        expect(publicL2).toBeDefined();

        // SAFETY: SELECT projects exactly dag_parent_id; .all() returns rows in that shape.
        const privParents = db.prepare(`SELECT DISTINCT dag_parent_id FROM memories WHERE id IN (${privFacts.map(() => '?').join(',')})`)
          .all(...privFacts.map((f) => f.id)) as Array<{ dag_parent_id: string }>;
        // SAFETY: SELECT projects exactly dag_parent_id; .all() returns rows in that shape.
        const pubParents = db.prepare(`SELECT DISTINCT dag_parent_id FROM memories WHERE id IN (${pubFacts.map(() => '?').join(',')})`)
          .all(...pubFacts.map((f) => f.id)) as Array<{ dag_parent_id: string }>;
        expect(privParents).toHaveLength(1);
        expect(pubParents).toHaveLength(1);
        expect(privParents[0]!.dag_parent_id).toBe(privateL2!.id);
        expect(pubParents[0]!.dag_parent_id).toBe(publicL2!.id);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('buildEntityProfiles never parents a private L2 and a public L2 under the same L3, and the private L3 carries the scope', async () => {
    const home = tmpHome();
    try {
      initStore(home);
      const makeL2 = (content: string, scope: string | null) => createMemory(content, {
        layer: Layer.Semantic, tags: ['speaker:alice', 'dag-summary'], confidence: 'inferred', dag_level: 2, scope,
      });
      const privL2s = [
        'alice prefers python type hints privately',
        'alice ships features in 2-week cycles privately',
        'alice owns the API layer privately',
      ].map((c) => makeL2(c, 'slack:private:C1'));
      const pubL2s = [
        'alice writes typescript publicly',
        'alice prefers strict mode publicly',
        'alice owns the frontend publicly',
      ].map((c) => makeL2(c, null));
      for (const l2 of [...privL2s, ...pubL2s]) writeEntry(home, l2);

      const fetcher = makeOkFetcher('synthetic-scope-partitioned-profile');
      const result = await buildEntityProfiles(home, [...privL2s, ...pubL2s], { apiKey: 'k', fetcher });

      expect(result.profilesCreated).toBe(2);
      expect(result.l2sLinked).toBe(6);

      const db = openHippoDb(home);
      try {
        // SAFETY: SELECT projects exactly id, scope; .all() returns rows in that shape.
        const l3s = db.prepare(`SELECT id, scope FROM memories WHERE dag_level = 3`).all() as Array<{ id: string; scope: string | null }>;
        expect(l3s).toHaveLength(2);
        const privateL3 = l3s.find((s) => s.scope === 'slack:private:C1');
        const publicL3 = l3s.find((s) => s.scope === null);
        expect(privateL3).toBeDefined();
        expect(publicL3).toBeDefined();

        // SAFETY: SELECT projects exactly dag_parent_id; .all() returns rows in that shape.
        const privParents = db.prepare(`SELECT DISTINCT dag_parent_id FROM memories WHERE id IN (${privL2s.map(() => '?').join(',')})`)
          .all(...privL2s.map((l2) => l2.id)) as Array<{ dag_parent_id: string }>;
        expect(privParents).toHaveLength(1);
        expect(privParents[0]!.dag_parent_id).toBe(privateL3!.id);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T3: extract.ts storeExtractedFacts copies the source scope', () => {
  it('facts extracted from a private-scope source carry that scope', () => {
    const home = tmpHome();
    try {
      initStore(home);
      const source = createMemory('Alice prefers dark mode and vim keybindings', {
        layer: Layer.Episodic,
        scope: 'slack:private:C1',
      });
      writeEntry(home, source);

      const facts: ExtractedFact[] = [
        { content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' },
      ];
      const stored = storeExtractedFacts(home, source, facts);

      expect(stored).toHaveLength(1);
      expect(stored[0]!.scope).toBe('slack:private:C1');
      const persisted = loadAllEntries(home).find((e) => e.id === stored[0]!.id);
      expect(persisted!.scope).toBe('slack:private:C1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T6: assembleBriefFromReceipts excludes restricted receipts', () => {
  function addReceipt(home: string, repo: string, content: string, scope: string | null): string {
    const mem = createMemory(content, {
      tags: [`path:${repo.toLowerCase()}`, 'note'],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'manual',
      scope,
    });
    writeEntry(home, mem);
    return mem.id;
  }

  it('quotes the public receipt only, excluding a slack:private and a mixed-case Slack:Private receipt', () => {
    const home = tmpHome();
    try {
      initStore(home);
      saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'seed' });
      addReceipt(home, 'hippo', 'the public deploy went out on schedule', null);
      addReceipt(home, 'hippo', 'the private incident channel discussed the outage', 'slack:private:C1');
      addReceipt(home, 'hippo', 'another restricted note in mixed case', 'Slack:Private:C9');

      const { markdown, receiptCount } = assembleBriefFromReceipts(home, 'default', 'hippo');

      expect(receiptCount).toBe(1);
      expect(markdown).toContain('the public deploy went out on schedule');
      expect(markdown).not.toContain('the private incident channel discussed the outage');
      expect(markdown).not.toContain('another restricted note in mixed case');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
