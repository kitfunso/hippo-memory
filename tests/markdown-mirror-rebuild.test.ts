import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { serializeEntry } from '../src/store/markdown.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

let storeRoot: string;

beforeEach(() => {
  storeRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mirror-rebuild-')), '.hippo');
  fs.mkdirSync(path.join(storeRoot, 'episodic'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(path.dirname(storeRoot), { recursive: true, force: true });
});

describe('a store rebuilt from its markdown mirror', () => {
  it('keeps supersession, the validity start and the DAG links', () => {
    const summary = { ...createMemory('the team ships on Fridays'), dag_level: 2 };
    const fact = {
      ...createMemory('alice said the team ships on Thursdays'),
      valid_from: '2026-01-02T03:04:05.000Z',
      superseded_by: summary.id,
      extracted_from: 'session-42',
      dag_level: 1,
      dag_parent_id: summary.id,
    };
    for (const entry of [summary, fact]) {
      fs.writeFileSync(path.join(storeRoot, 'episodic', `${entry.id}.md`), serializeEntry(entry));
    }

    initStore(storeRoot);

    const byId = new Map(loadAllEntries(storeRoot).map((e) => [e.id, e]));
    const back = byId.get(fact.id);
    expect(back?.valid_from).toBe('2026-01-02T03:04:05.000Z');
    expect(back?.superseded_by).toBe(summary.id);
    expect(back?.extracted_from).toBe('session-42');
    expect(back?.dag_level).toBe(1);
    expect(back?.dag_parent_id).toBe(summary.id);
    expect(byId.get(summary.id)?.dag_level).toBe(2);
  });
});
