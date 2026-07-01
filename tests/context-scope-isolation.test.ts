/**
 * v39 memory scope isolation - the cross-project leak tests (plan S2/S3,
 * docs/plans/2026-07-01-memory-scope-isolation.md).
 *
 * Reproduces the 2026-07-01 bug shape: a project-A session whose global
 * store carries rows owned by OTHER projects. Before v39, every mode of
 * getContext injected them; the existing api-context tests could not catch
 * this because they isolate the global store away entirely.
 *
 * Real-DB per project convention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createMemory } from '../src/memory.js';
import { getContext, type Context } from '../src/api.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';

let tmpRoot: string;
let projA: string;
let globalStore: string;
let origHippoHome: string | undefined;
let ctx: Context;

const ALPHA = 'ALPHA-RULE deploykey rotation happens on fridays';
const GLOBAL_PREF = 'GLOBAL-PREF deploykey answers stay under three lines';
const BRAVO = 'BRAVO-FACT deploykey for project bravo lives in vault slot 7';
const LEGACY = 'LEGACY-ROW deploykey note from before origin tracking';

function contents(entries: Array<{ entry: { content: string } }>): string[] {
  return entries.map((r) => r.entry.content);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ctx-iso-'));
  projA = path.join(tmpRoot, 'proj-a', '.hippo');
  fs.mkdirSync(projA, { recursive: true });
  initStore(projA);
  globalStore = path.join(tmpRoot, 'globalstore');
  initStore(globalStore);
  origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = globalStore;
  clearProjectIdentityCache();

  writeEntry(projA, createMemory(ALPHA, { pinned: true }));
  writeEntry(globalStore, { ...createMemory(GLOBAL_PREF, { pinned: true }), origin_project: '' });
  writeEntry(globalStore, { ...createMemory(BRAVO, { pinned: true }), origin_project: 'proj-b' });
  writeEntry(globalStore, { ...createMemory(LEGACY, { pinned: true }), origin_project: 'placeholder' });
  const db = openHippoDb(globalStore);
  try {
    db.prepare(`UPDATE memories SET origin_project = NULL WHERE content = ?`).run(LEGACY);
  } finally {
    closeHippoDb(db);
  }

  ctx = { hippoRoot: projA, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  if (origHippoHome !== undefined) {
    process.env.HIPPO_HOME = origHippoHome;
  } else {
    delete process.env.HIPPO_HOME;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getContext origin partition (project A session)', () => {
  const base = { currentProject: 'proj-a' };

  it('pinned mode: other-project and legacy rows never inject; own + user-global do', async () => {
    const result = await getContext(ctx, { ...base, pinnedOnly: true });
    const got = contents(result.entries);
    expect(got).toContain(ALPHA);
    expect(got).toContain(GLOBAL_PREF);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
  });

  it("'*' fallback mode applies the same partition", async () => {
    const result = await getContext(ctx, { ...base });
    const got = contents(result.entries);
    expect(got).toContain(ALPHA);
    expect(got).toContain(GLOBAL_PREF);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
  });

  it('query mode applies the same partition to searchBothHybrid results', async () => {
    const result = await getContext(ctx, { ...base, q: 'deploykey' });
    const got = contents(result.entries);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
    expect(got.length).toBeGreaterThan(0);
  });

  it('annotates returned entries with origin and category', async () => {
    const result = await getContext(ctx, { ...base, pinnedOnly: true });
    const alpha = result.entries.find((r) => r.entry.content === ALPHA);
    const pref = result.entries.find((r) => r.entry.content === GLOBAL_PREF);
    expect(alpha?.origin).toBe('proj-a');
    expect(alpha?.category).toBe('project');
    expect(pref?.origin).toBe('');
    expect(pref?.category).toBe('user-global');
  });

  it('crossProject: true re-includes excluded rows tagged cross-project', async () => {
    const result = await getContext(ctx, { ...base, pinnedOnly: true, crossProject: true });
    const got = contents(result.entries);
    expect(got).toContain(BRAVO);
    expect(got).toContain(LEGACY);
    const bravo = result.entries.find((r) => r.entry.content === BRAVO);
    expect(bravo?.category).toBe('cross-project');
  });

  it('contextProjectIsolation: false restores legacy behavior wholesale', async () => {
    fs.writeFileSync(
      path.join(projA, 'config.json'),
      JSON.stringify({ contextProjectIsolation: false }),
    );
    const result = await getContext(ctx, { ...base, pinnedOnly: true });
    const got = contents(result.entries);
    expect(got).toContain(BRAVO);
    expect(got).toContain(LEGACY);
  });

  it('a non-project session (currentProject "") sees everything, matching pre-v39 behavior', async () => {
    const result = await getContext(ctx, { currentProject: '', pinnedOnly: true });
    const got = contents(result.entries);
    expect(got).toContain(ALPHA);
    expect(got).toContain(GLOBAL_PREF);
    expect(got).toContain(BRAVO);
    expect(got).toContain(LEGACY);
  });

  it('query mode: an excluded high-token cross-project row cannot starve admitted rows out of the budget', async () => {
    // A large cross-project row that matches the query strongly; the small
    // in-scope rows must still fill the (tiny) budget after it is excluded.
    writeEntry(globalStore, {
      ...createMemory('deploykey deploykey deploykey ' + 'filler text for bulk '.repeat(40)),
      origin_project: 'proj-b',
    });
    const result = await getContext(ctx, { currentProject: 'proj-a', q: 'deploykey', budget: 60 });
    const got = contents(result.entries);
    expect(got.length).toBeGreaterThan(0);
    expect(got.join('\n')).not.toContain('filler text for bulk');
  });

  it('an excluded duplicate cannot shadow its admitted copy in query mode (admission runs before dedupe)', async () => {
    const DUP = 'deploykey duplicated fact shared to global';
    writeEntry(projA, { ...createMemory(DUP, { scope: 'github:private:x' }) }); // excluded (private scope)
    writeEntry(globalStore, { ...createMemory(DUP), origin_project: '' });      // admitted (user-global)
    const result = await getContext(ctx, { currentProject: 'proj-a', q: 'deploykey duplicated' });
    expect(contents(result.entries)).toContain(DUP);
  });

  it('private-scope rows never ambient-inject even from the local store (S2 parity)', async () => {
    const secret = 'PRIVATE-SCOPED deploykey row that must not inject';
    writeEntry(projA, { ...createMemory(secret, { pinned: true, scope: 'github:private:repo-x' }) });
    const result = await getContext(ctx, { ...base, pinnedOnly: true });
    expect(contents(result.entries)).not.toContain(secret);
  });
});
