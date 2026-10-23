/**
 * v39 memory scope isolation - the cross-project leak tests (plan S2/S3,
 * docs/plans/2026-07-01-memory-scope-isolation.md).
 *
 * Reproduces the 2026-07-01 bug shape: a project-A session whose global
 * store carries rows owned by OTHER projects. Before v39, every mode of
 * contextGet injected them; the existing api-context tests could not catch
 * this because they isolate the global store away entirely.
 *
 * Real-DB per project convention.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { contextGet } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/host/config-file.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

afterEach(() => {
  vi.unstubAllEnvs();
});

let tmpRoot: string;
let projA: string;
let globalStore: string;
let ctx: FullContext;

const ALPHA = 'ALPHA-RULE deploykey rotation happens on fridays';
const GLOBAL_PREF = 'GLOBAL-PREF deploykey answers stay under three lines';
const BRAVO = 'BRAVO-FACT deploykey for project bravo lives in vault slot 7';
const LEGACY = 'LEGACY-ROW deploykey note from before origin tracking';

function contents(entries: Array<{ entry: { content: string } }>): string[] {
  return entries.map((r) => r.entry.content);
}

beforeEach(() => {
  tmpRoot = makeRoot('ctx-iso', { init: false });
  projA = path.join(tmpRoot, 'proj-a', '.hippo');
  fs.mkdirSync(projA, { recursive: true });
  initTestStore(projA);
  globalStore = path.join(tmpRoot, 'globalstore');
  initTestStore(globalStore);
  vi.stubEnv('HIPPO_HOME', globalStore);

  writeEntry(projA, createMemory(ALPHA, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, pinned: true }));
  writeEntry(globalStore, {
    ...createMemory(GLOBAL_PREF, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, pinned: true }),
    originProject: '',
  });
  writeEntry(globalStore, {
    ...createMemory(BRAVO, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, pinned: true }),
    originProject: 'proj-b',
  });
  writeEntry(globalStore, {
    ...createMemory(LEGACY, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, pinned: true }),
    originProject: 'placeholder',
  });
  const db = openHippoDb(globalStore);
  try {
    db.prepare(`UPDATE memories SET origin_project = NULL WHERE content = ?`).run(LEGACY);
  } finally {
    closeHippoDb(db);
  }

  ctx = apiCtx(projA, 'default', { subject: 'cli', role: 'admin' });
});

describe('contextGet origin partition (project A session)', () => {
  const base = { currentProject: 'proj-a' };

  it('pinned mode: other-project and legacy rows never inject; own + user-global do', async () => {
    const result = await contextGet(ctx, { ...base, pinnedOnly: true });
    const got = contents(result.entries);
    expect(got).toContain(ALPHA);
    expect(got).toContain(GLOBAL_PREF);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
  });

  it("'*' fallback mode applies the same partition", async () => {
    const result = await contextGet(ctx, { ...base });
    const got = contents(result.entries);
    expect(got).toContain(ALPHA);
    expect(got).toContain(GLOBAL_PREF);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
  });

  it('query mode applies the same partition to searchBothHybrid results', async () => {
    const result = await contextGet(ctx, { ...base, q: 'deploykey' });
    const got = contents(result.entries);
    expect(got).not.toContain(BRAVO);
    expect(got).not.toContain(LEGACY);
    expect([...got].sort()).toEqual([ALPHA, GLOBAL_PREF]);
  });

  it('annotates returned entries with origin and category', async () => {
    const result = await contextGet(ctx, { ...base, pinnedOnly: true });
    const alpha = result.entries.find((r) => r.entry.content === ALPHA);
    const pref = result.entries.find((r) => r.entry.content === GLOBAL_PREF);
    expect(alpha?.origin).toBe('proj-a');
    expect(alpha?.category).toBe('project');
    expect(pref?.origin).toBe('');
    expect(pref?.category).toBe('user-global');
  });

  it('crossProject: true re-includes excluded rows tagged cross-project', async () => {
    const result = await contextGet(ctx, { ...base, pinnedOnly: true, crossProject: true });
    const got = contents(result.entries);
    expect(got).toContain(BRAVO);
    expect(got).toContain(LEGACY);
    const bravo = result.entries.find((r) => r.entry.content === BRAVO);
    expect(bravo?.category).toBe('cross-project');
  });

  it('contextProjectIsolation: false restores legacy behavior wholesale', async () => {
    fs.writeFileSync(path.join(projA, 'config.json'), JSON.stringify({ contextProjectIsolation: false }));
    const result = await contextGet({ ...ctx, config: loadConfig(projA) }, { ...base, pinnedOnly: true });
    const got = contents(result.entries);
    expect(got).toContain(BRAVO);
    expect(got).toContain(LEGACY);
  });

  it('a non-project session (currentProject "") sees everything, matching pre-v39 behavior', async () => {
    const result = await contextGet(ctx, { currentProject: '', pinnedOnly: true });
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
      ...createMemory('deploykey deploykey deploykey ' + 'filler text for bulk '.repeat(40), {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      }),
      originProject: 'proj-b',
    });
    const result = await contextGet(ctx, { currentProject: 'proj-a', q: 'deploykey', budget: 60 });
    const got = contents(result.entries);
    // The two admitted rows cost 12 and 13 tokens, so both fit the 60-token budget once the bulk row is out.
    expect([...got].sort()).toEqual([ALPHA, GLOBAL_PREF]);
    expect(got.join('\n')).not.toContain('filler text for bulk');
  });

  it('an excluded duplicate cannot shadow its admitted copy in query mode (admission runs before dedupe)', async () => {
    const DUP = 'deploykey duplicated fact shared to global';
    writeEntry(projA, {
      ...createMemory(DUP, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, scope: 'github:private:x' }),
    }); // excluded (private scope)
    writeEntry(globalStore, { ...createMemory(DUP, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), originProject: '' }); // admitted (user-global)
    const result = await contextGet(ctx, { currentProject: 'proj-a', q: 'deploykey duplicated' });
    expect(contents(result.entries)).toContain(DUP);
  });

  it('private-scope rows never ambient-inject even from the local store', async () => {
    const secret = 'PRIVATE-SCOPED deploykey row that must not inject';
    writeEntry(projA, {
      ...createMemory(secret, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        pinned: true,
        scope: 'github:private:repo-x',
      }),
    });
    const result = await contextGet(ctx, { ...base, pinnedOnly: true });
    expect(contents(result.entries)).not.toContain(secret);
  });
});
