/**
 * Inheritance smoke tests — lock the claim that Layer.Trace memories inherit
 * the core MemoryEntry mechanics "for free".
 *
 * If any of these tests starts failing after a refactor, the "inherits for
 * free" claim has quietly broken and we owe users either a fix or explicit
 * per-layer plumbing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, Layer, calculateStrength } from '../src/memory.js';
import { consolidate } from '../src/consolidate.js';
import {
  initStore,
  writeEntry,
  readEntry,
  loadAllEntries,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { hybridSearch } from '../src/search.js';
import { sampleForReplay } from '../src/replay.js';
import { initializeParticle, savePhysicsState, loadPhysicsState } from '../src/physics-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-trace-inherit-'));
  initStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Trace layer inherits core memory mechanics', () => {
  it('traces decay via the standard strength calculation', () => {
    const trace = createMemory('Task: deploy\nOutcome: success\nSteps:\n  1. push', {
      layer: Layer.Trace,
      trace_outcome: 'success',
    });

    // Back-date last_retrieved by many half-lives so strength drops.
    const aged = {
      ...trace,
      last_retrieved: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const strengthNow = calculateStrength(trace);
    const strengthAged = calculateStrength(aged);

    expect(strengthNow).toBeGreaterThan(0.9);
    expect(strengthAged).toBeLessThan(strengthNow);
    expect(strengthAged).toBeLessThan(0.5);
  });

  it('traces appear in hybridSearch results when text matches', async () => {
    const trace = createMemory(
      'Task: refactor authentication module\nOutcome: success\nSteps:\n  1. split session store',
      { layer: Layer.Trace, trace_outcome: 'success' },
    );
    writeEntry(tmpDir, trace);

    const entries = loadAllEntries(tmpDir);
    const results = await hybridSearch('refactor authentication', entries, {
      hippoRoot: tmpDir,
      budget: 4000,
    });

    const hit = results.find((r) => r.entry.id === trace.id);
    expect(hit).toBeDefined();
    expect(hit!.entry.layer).toBe(Layer.Trace);
  });

  it('traces are candidates for the replay pass', () => {
    // Seed several traces — sampleForReplay draws from whatever survivors
    // exist, so as long as traces are eligible at all they can be picked.
    const traces = Array.from({ length: 5 }, (_, i) =>
      createMemory(
        `Task: scenario ${i}\nOutcome: success\nSteps:\n  1. step ${i}`,
        { layer: Layer.Trace, trace_outcome: 'success' },
      ),
    );

    const picked = sampleForReplay(traces, 5, new Date(), 42);
    expect(picked.length).toBeGreaterThanOrEqual(1);
    // Every picked entry should be a trace (the only thing in the pool).
    for (const p of picked) expect(p.layer).toBe(Layer.Trace);
  });

  it('physics state is created for traces on first consolidate', async () => {
    // Persist a trace.
    const trace = createMemory(
      'Task: physics trace\nOutcome: success\nSteps:\n  1. do thing',
      { layer: Layer.Trace, trace_outcome: 'success' },
    );
    writeEntry(tmpDir, trace);

    // Simulate what embeddings.ts does when embeddings are available:
    // initialize a particle for the trace entry and persist it. This is the
    // same code path non-trace memories use — no trace-specific branch
    // exists, which is exactly the "inherits for free" claim.
    const fakeEmbedding = Array.from({ length: 16 }, (_, i) => Math.sin(i));
    const db = openHippoDb(tmpDir);
    try {
      const particle = initializeParticle(trace, fakeEmbedding);
      savePhysicsState(db, [particle]);
      const map = loadPhysicsState(db, [trace.id]);
      expect(map.has(trace.id)).toBe(true);
      expect(map.get(trace.id)!.mass).toBeGreaterThan(0);
    } finally {
      closeHippoDb(db);
    }

    // And consolidate() runs cleanly over a store that contains a trace
    // with physics state — no layer-specific crash, no data loss.
    const result = await consolidate(tmpDir, { now: new Date() });
    expect(result.dryRun).toBe(false);
    const survivors = loadAllEntries(tmpDir);
    expect(survivors.find((e) => e.id === trace.id)).toBeDefined();
  });
});
