import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { deserializeEntry, serializeEntry } from '../../src/base/memory/markdown.js';
import { log } from '../../src/base/util/log.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

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

    initTestStore(storeRoot);

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

/** The mirror text of `entry` with its confidence line replaced, or dropped when `line` is null. */
function withConfidenceLine(entry: MemoryEntry, line: string | null): string {
  return serializeEntry(entry).replace(/^confidence: .*\n/m, line === null ? '' : `${line}\n`);
}

describe('a mirror file with a confidence outside the four tiers', () => {
  it('is skipped with a warning naming file, row and value, and the other files load', () => {
    const good = { ...createMemory('the team ships on Fridays'), confidence: 'inferred' as const };
    const bad = createMemory('the build runs nightly');
    const bare = createMemory('the cache is warmed at six');
    const empty = createMemory('the queue drains at noon');
    const texts = [
      [good, serializeEntry(good)],
      [bad, withConfidenceLine(bad, 'confidence: high')],
      [bare, withConfidenceLine(bare, null)],
      [empty, withConfidenceLine(empty, 'confidence:')],
    ] as const;
    for (const [entry, text] of texts) {
      fs.writeFileSync(path.join(storeRoot, 'episodic', `${entry.id}.md`), text);
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    initTestStore(storeRoot);

    const byId = new Map(loadAllEntries(storeRoot, 'default').map((e) => [e.id, e]));
    expect(byId.get(good.id)?.confidence).toBe('inferred');
    expect(byId.get(bare.id)?.confidence).toBe('observed');
    expect(byId.get(empty.id)?.confidence).toBe('observed');
    expect(byId.has(bad.id)).toBe(false);
    const message = warn.mock.calls.map(([text]) => text).join('\n');
    expect(message).toContain(`${bad.id}.md`);
    expect(message).toContain(`memory ${bad.id}: unknown confidence "high"`);
    warn.mockRestore();
  });

  it('is refused by deserializeEntry with the tiers to use', () => {
    const bad = createMemory('the build runs nightly');
    const text = withConfidenceLine(bad, 'confidence: high');

    expect(() => deserializeEntry(text, new Date())).toThrow(
      `memory ${bad.id}: unknown confidence "high"; use verified, observed, inferred or stale; ` +
        'the file stays on disk, and deleting hippo.db to rebuild is safe only before any new write',
    );
  });
});
