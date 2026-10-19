import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { serializeEntry } from '../../src/core/markdown.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initStore } from '../../src/store/sqlite/handles.js';

let storeRoot: string;

beforeEach(() => {
  storeRoot = path.join(makeRoot('mirror-rebuild', { init: false }), '.hippo');
  fs.mkdirSync(path.join(storeRoot, 'episodic'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(storeRoot), { recursive: true, force: true });
});

describe('a store rebuilt from its markdown mirror', () => {
  it('keeps supersession, the validity start and the DAG links', () => {
    const summary = { ...createMemory('the team ships on Fridays'), dagLevel: 2 };
    const fact = {
      ...createMemory('alice said the team ships on Thursdays'),
      validFrom: '2026-01-02T03:04:05.000Z',
      supersededBy: summary.id,
      extractedFrom: 'session-42',
      dagLevel: 1,
      dagParentId: summary.id,
    };
    for (const entry of [summary, fact]) {
      fs.writeFileSync(path.join(storeRoot, 'episodic', `${entry.id}.md`), serializeEntry(entry));
    }

    initStore(storeRoot);

    const byId = new Map(loadAllEntries(storeRoot, 'default').map((e) => [e.id, e]));
    const back = byId.get(fact.id);
    expect(back?.validFrom).toBe('2026-01-02T03:04:05.000Z');
    expect(back?.supersededBy).toBe(summary.id);
    expect(back?.extractedFrom).toBe('session-42');
    expect(back?.dagLevel).toBe(1);
    expect(back?.dagParentId).toBe(summary.id);
    expect(byId.get(summary.id)?.dagLevel).toBe(2);
  });
});
