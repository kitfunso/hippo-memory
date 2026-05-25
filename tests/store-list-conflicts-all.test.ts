/**
 * v0.28 — listMemoryConflicts '*' sentinel test (E2 real-edges).
 *
 * Verifies the new 'all statuses' sentinel and that existing 'open' callers
 * (cli.ts, mcp/server.ts, dashboard.ts, consolidate-extraction.test.ts) see
 * NO behaviour change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initStore,
  writeEntry,
  listMemoryConflicts,
  replaceDetectedConflicts,
} from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-list-conflicts-all-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listMemoryConflicts '*' sentinel (v0.28)", () => {
  it("returns only open conflicts when status='open' (legacy behaviour)", () => {
    initStore(tmpDir);
    const a = createMemory('alpha', { layer: Layer.Semantic });
    const b = createMemory('beta', { layer: Layer.Semantic });
    const c = createMemory('gamma', { layer: Layer.Semantic });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    writeEntry(tmpDir, c);

    // Insert two open conflicts.
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'r1', score: 0.7 },
      { memory_a_id: b.id, memory_b_id: c.id, reason: 'r2', score: 0.7 },
    ]);

    // Resolve one by re-running with only the other.
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: b.id, memory_b_id: c.id, reason: 'r2', score: 0.7 },
    ]);

    const openOnly = listMemoryConflicts(tmpDir, 'open');
    expect(openOnly).toHaveLength(1);
    expect(openOnly[0]?.status).toBe('open');
  });

  it("returns ALL conflicts (open + resolved) when status='*' (new sentinel)", () => {
    initStore(tmpDir);
    const a = createMemory('alpha', { layer: Layer.Semantic });
    const b = createMemory('beta', { layer: Layer.Semantic });
    const c = createMemory('gamma', { layer: Layer.Semantic });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    writeEntry(tmpDir, c);

    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'r1', score: 0.7 },
      { memory_a_id: b.id, memory_b_id: c.id, reason: 'r2', score: 0.7 },
    ]);
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: b.id, memory_b_id: c.id, reason: 'r2', score: 0.7 },
    ]);

    const all = listMemoryConflicts(tmpDir, '*');
    expect(all).toHaveLength(2);
    const statuses = all.map((c) => c.status).sort();
    expect(statuses).toEqual(['open', 'resolved']);
  });

  it("default param remains 'open' (caller-free regression check)", () => {
    initStore(tmpDir);
    const a = createMemory('alpha', { layer: Layer.Semantic });
    const b = createMemory('beta', { layer: Layer.Semantic });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'r1', score: 0.7 },
    ]);
    replaceDetectedConflicts(tmpDir, []);

    // listMemoryConflicts(tmpDir) === listMemoryConflicts(tmpDir, 'open')
    const def = listMemoryConflicts(tmpDir);
    expect(def).toHaveLength(0); // only resolved exists; default 'open' filter hides it
  });

  it("returns empty when filtering by 'resolved' and no resolved exist", () => {
    initStore(tmpDir);
    const a = createMemory('alpha', { layer: Layer.Semantic });
    const b = createMemory('beta', { layer: Layer.Semantic });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);
    replaceDetectedConflicts(tmpDir, [
      { memory_a_id: a.id, memory_b_id: b.id, reason: 'r1', score: 0.7 },
    ]);

    const resolved = listMemoryConflicts(tmpDir, 'resolved');
    expect(resolved).toHaveLength(0);

    const allStill = listMemoryConflicts(tmpDir, '*');
    expect(allStill).toHaveLength(1);
    expect(allStill[0]?.status).toBe('open');
  });
});
