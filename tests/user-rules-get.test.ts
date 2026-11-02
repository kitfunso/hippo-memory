// userRulesGet hands the session-start hook every rule the person taught this project, with no budget to cut a long list.
// Real SQLite stores in tmp dirs; HIPPO_HOME names the global store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adminActor, userRulesGet, type Context } from '../src/api/index.js';
import { USER_RULE_TAG } from '../src/api/user-rule.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntriesTogether, writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const PROJECT = { name: 'p', legacyName: 'p' };
const FIRST_MS = Date.UTC(2026, 0, 1);

let tmp: string;
let store: string;
let globalRoot: string;

/** The row capture writes for a rule the person stated; `n` sets its age, so a higher n is newer. */
function ruleRow(n: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
  const row = createMemory(`Rule ${n}: keep change note ${n} in its own file`, {
    source: 'capture',
    confidence: 'observed',
    pinned: true,
    tags: ['rule', 'captured', USER_RULE_TAG],
  });
  return { ...row, origin_project: 'p', created: new Date(FIRST_MS + n * 60_000).toISOString(), ...over };
}

/** A pinned row an agent or a person saved by hand, which is no user rule. */
function noteRow(n: number): MemoryEntry {
  return { ...createMemory(`Note ${n}: deploys go through the staging queue`, { pinned: true }), origin_project: 'p' };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-user-rules-get-'));
  store = path.join(tmp, 'proj', '.hippo');
  globalRoot = path.join(tmp, 'global');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(store);
  initStore(globalRoot);
  vi.stubEnv('HIPPO_HOME', globalRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (): Context => ({ hippoRoot: store, tenantId: 'default', actor: adminActor('user-rules-get-test') });
const idsOf = (rows: readonly MemoryEntry[]): string[] => rows.map((e) => e.id);

describe('userRulesGet', () => {
  it('returns all 60 user rules oldest first while 100 other pins sit beside them', async () => {
    const rules = Array.from({ length: 60 }, (_, n) => ruleRow(n));
    // Newest first, so the store's own order cannot pass for the sort.
    writeEntriesTogether(store, [...rules].reverse());
    writeEntriesTogether(store, Array.from({ length: 100 }, (_, n) => noteRow(n)));

    expect(idsOf(await userRulesGet(ctx(), { currentProject: PROJECT }))).toEqual(idsOf(rules));
  });

  it('returns a global-store rule stamped with this project, and not one stamped with another', async () => {
    const mine = ruleRow(0);
    writeEntry(globalRoot, mine);
    writeEntry(globalRoot, ruleRow(1, { origin_project: 'other' }));
    writeEntry(globalRoot, ruleRow(2, { origin_project: null }));

    expect(idsOf(await userRulesGet(ctx(), { currentProject: PROJECT }))).toEqual([mine.id]);
  });

  it('merges the project store and the global store by age, and lists an id both hold once', async () => {
    const [oldest, middle, newest] = [ruleRow(0), ruleRow(1), ruleRow(2)];
    writeEntry(store, middle);
    writeEntry(store, newest);
    writeEntry(globalRoot, oldest);
    writeEntry(globalRoot, newest);

    expect(idsOf(await userRulesGet(ctx(), { currentProject: PROJECT }))).toEqual(idsOf([oldest, middle, newest]));
  });

  it('returns nothing when pinned injection is off', async () => {
    writeEntry(store, ruleRow(0));
    fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ pinnedInject: { enabled: false } }));

    expect(await userRulesGet(ctx(), { currentProject: PROJECT })).toEqual([]);
  });
});
