/**
 * Graph-hop scope parity (v1.26.1) — docs/plans/2026-07-11-graph-hop-scope-parity.md.
 *
 * `graphExpandRecall` loads graph-REACHED memories directly by id (bypassing the
 * lexical candidate set), so it must re-apply the v39 recall scope rule itself —
 * base recall's SQL/JS scope filters never see these rows. Covers the fail-closed
 * default (bare/SDK callers), the CLI additive unlock, the api exact-narrowing
 * mode, the quarantine bucket, the global-root traversal path, and unlock
 * composition against a second, non-requested private scope. Real SQLite stores,
 * no mocks (repo law).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { estimateTokens, type SearchResult } from '../src/search.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { graphExpandRecall } from '../src/graph-recall.js';

const HIPPO_BIN = join(process.cwd(), 'bin', 'hippo.js');

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graphrecall-scope-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
/** Write a distilled memory (createMemory's default kind — the only kind graph writers
 *  accept per the E3.3 consolidated-source guard) and return the full entry. */
function mem(home: string, tenant: string, text: string, opts: { scope?: string | null } = {}): MemoryEntry {
  const content = text.length < 3 ? text.repeat(3) : text;
  const m = createMemory(content, {
    tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test',
    tenantId: tenant, scope: opts.scope ?? null,
  });
  writeEntry(home, m, { actor: 'test' });
  return m;
}
function sr(entry: MemoryEntry, score: number): SearchResult {
  return { entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) };
}
function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
  return insertEntity(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
}
function hippo(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('node', [HIPPO_BIN, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' });
}

describe('graph-recall scope parity (v1.26.1)', () => {
  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('core: a graph-reached private-scoped memory is default-denied (no recallScope = fail-closed)', () => {
    const seed = mem(home, T, 'decision alpha about cache invalidation strategy');
    const priv = mem(home, T, 'wholly unrelated private wording xyzzy plugh frobnicate', { scope: 'slack:private:dm1' });
    const eSeed = ent(home, T, seed, 'SEED');
    const ePriv = ent(home, T, priv, 'PRIV');
    // priv is the `from` endpoint (reached direction 'from'), so it is not treated as a
    // superseded endpoint and would surface by default absent the scope fix.
    insertRelation(home, T, { fromEntityId: ePriv, toEntityId: eSeed, relType: 'supersedes', memoryId: priv.id });

    const out = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(out.map((r) => r.entry.id)).not.toContain(priv.id);
  });

  it('CLI unlock: recallScope { requested: dm1, additive: true } surfaces the private row (parity with base-recall unlock)', () => {
    const seed = mem(home, T, 'decision alpha about cache invalidation strategy');
    const priv = mem(home, T, 'wholly unrelated private wording xyzzy plugh frobnicate', { scope: 'slack:private:dm1' });
    const eSeed = ent(home, T, seed, 'SEED');
    const ePriv = ent(home, T, priv, 'PRIV');
    insertRelation(home, T, { fromEntityId: ePriv, toEntityId: eSeed, relType: 'supersedes', memoryId: priv.id });

    const out = graphExpandRecall([sr(seed, 1.0)], {
      hops: 1, hippoRoot: home, tenantId: T, budget: 4000,
      recallScope: { requested: 'slack:private:dm1', additive: true },
    });
    expect(out.map((r) => r.entry.id)).toContain(priv.id);
  });

  it('exact/api narrowing: requested without additive keeps only exact-scope rows (drops the NULL-scope neighbour too)', () => {
    const seed = mem(home, T, 'decision alpha about cache invalidation strategy');
    const nullNeighbor = mem(home, T, 'wholly unrelated public wording xyzzy plugh');
    const privNeighbor = mem(home, T, 'wholly unrelated private wording frobnicate zapzap', { scope: 'slack:private:dm1' });
    const eSeed = ent(home, T, seed, 'SEED');
    const eNull = ent(home, T, nullNeighbor, 'NULLN');
    const ePriv = ent(home, T, privNeighbor, 'PRIVN');
    insertRelation(home, T, { fromEntityId: eNull, toEntityId: eSeed, relType: 'supersedes', memoryId: nullNeighbor.id });
    insertRelation(home, T, { fromEntityId: ePriv, toEntityId: eSeed, relType: 'supersedes', memoryId: privNeighbor.id });

    const out = graphExpandRecall([sr(seed, 1.0)], {
      hops: 1, hippoRoot: home, tenantId: T, budget: 4000,
      recallScope: { requested: 'slack:private:dm1' }, // additive absent -> exact-narrowing (api semantics)
    });
    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain(privNeighbor.id);
    expect(ids).not.toContain(nullNeighbor.id);
  });

  it('quarantine deny: a reached row scoped unknown:legacy is dropped by default', () => {
    const seed = mem(home, T, 'decision alpha about cache invalidation strategy');
    const legacy = mem(home, T, 'wholly unrelated legacy wording xyzzy plugh quux', { scope: 'unknown:legacy' });
    const eSeed = ent(home, T, seed, 'SEED');
    const eLegacy = ent(home, T, legacy, 'LEGACY');
    insertRelation(home, T, { fromEntityId: eLegacy, toEntityId: eSeed, relType: 'supersedes', memoryId: legacy.id });

    const out = graphExpandRecall([sr(seed, 1.0)], { hops: 1, hippoRoot: home, tenantId: T, budget: 4000 });
    expect(out.map((r) => r.entry.id)).not.toContain(legacy.id);
  });

  it('global-root: a private-scoped memory reachable only via the GLOBAL store graph is dropped by default', () => {
    const glob = makeRoot();
    try {
      // Seed + graph live entirely in the GLOBAL store; `home` (local) has no entities.
      const seed = mem(glob, T, 'globally-stored seed decision about cache invalidation');
      const priv = mem(glob, T, 'globally-stored private linked wording xyzzy plugh', { scope: 'slack:private:dm1' });
      const eSeed = ent(glob, T, seed, 'SEED');
      const ePriv = ent(glob, T, priv, 'PRIV');
      insertRelation(glob, T, { fromEntityId: ePriv, toEntityId: eSeed, relType: 'supersedes', memoryId: priv.id });

      const out = graphExpandRecall([sr(seed, 1.0)], {
        hops: 1, hippoRoot: home, globalRoot: glob, tenantId: T, budget: 4000,
      });
      expect(out.map((r) => r.entry.id)).not.toContain(priv.id);
    } finally {
      safeRmSync(glob);
    }
  });

  it('unlock composition: dm1 additive unlock surfaces the NULL-scope + dm1 neighbours but a second private scope (dm2) stays denied', () => {
    const seed = mem(home, T, 'decision alpha about cache invalidation strategy');
    const nullNeighbor = mem(home, T, 'wholly unrelated public wording xyzzy plugh');
    const dm1 = mem(home, T, 'wholly unrelated dm1 private wording frobnicate zapzap', { scope: 'slack:private:dm1' });
    const dm2 = mem(home, T, 'wholly unrelated dm2 private wording quuxquux blorpblorp', { scope: 'slack:private:dm2' });
    const eSeed = ent(home, T, seed, 'SEED');
    const eNull = ent(home, T, nullNeighbor, 'NULLN');
    const eDm1 = ent(home, T, dm1, 'DM1');
    const eDm2 = ent(home, T, dm2, 'DM2');
    insertRelation(home, T, { fromEntityId: eNull, toEntityId: eSeed, relType: 'supersedes', memoryId: nullNeighbor.id });
    insertRelation(home, T, { fromEntityId: eDm1, toEntityId: eSeed, relType: 'supersedes', memoryId: dm1.id });
    insertRelation(home, T, { fromEntityId: eDm2, toEntityId: eSeed, relType: 'supersedes', memoryId: dm2.id });

    const out = graphExpandRecall([sr(seed, 1.0)], {
      hops: 1, hippoRoot: home, tenantId: T, budget: 4000,
      recallScope: { requested: 'slack:private:dm1', additive: true },
    });
    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain(nullNeighbor.id);
    expect(ids).toContain(dm1.id);
    expect(ids).not.toContain(dm2.id);
  });
});

describe('graph-recall scope parity — CLI e2e (v1.26.1)', () => {
  let cliHome: string;
  let env: Record<string, string>;

  beforeEach(() => {
    cliHome = mkdtempSync(join(tmpdir(), 'hippo-graphrecall-scope-cli-'));
    env = { HIPPO_HOME: join(cliHome, 'global-hippo'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    hippo(cliHome, env, 'init', '--no-hooks', '--no-schedule', '--no-learn');
  });
  afterEach(() => { if (cliHome) rmSync(cliHome, { recursive: true, force: true }); });

  it('`hippo recall <q> --hops 1` denies the private neighbour; `--scope slack:private:dm1 --hops 1` surfaces it', () => {
    const hippoDir = join(cliHome, '.hippo');
    const T = 'default';
    const seed = mem(hippoDir, T, 'decision alpha about cache invalidation graphhopscope');
    const priv = mem(hippoDir, T, 'wholly unrelated private wording frobnicate zapzap', { scope: 'slack:private:dm1' });
    const eSeed = ent(hippoDir, T, seed, 'SEED');
    const ePriv = ent(hippoDir, T, priv, 'PRIV');
    insertRelation(hippoDir, T, { fromEntityId: ePriv, toEntityId: eSeed, relType: 'supersedes', memoryId: priv.id });

    const denied = hippo(cliHome, env, 'recall', 'graphhopscope', '--hops', '1', '--limit', '10');
    expect(denied).toContain('decision alpha');
    expect(denied).not.toContain('frobnicate');

    const unlocked = hippo(cliHome, env, 'recall', 'graphhopscope', '--hops', '1', '--scope', 'slack:private:dm1', '--limit', '10');
    expect(unlocked).toContain('frobnicate');
  });
});
