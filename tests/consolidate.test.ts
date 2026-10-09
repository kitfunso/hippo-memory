import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { consolidate } from '../src/consolidate/sleep.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { listMemoryConflicts } from '../src/store/conflicts.js';
import { createMemory, Layer, calculateStrength, resolveConfidence, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from '../src/db/physics-state.js';
import { simulate, type PhysicsParticle } from '../src/physics.js';

/** Sleep and decay here run on the pre-1.46 7-day base, so memories fade within the test's horizon. */
const createMemory7 = (content: string, options: Partial<Parameters<typeof createMemory>[1]> = {}) => createMemory(content, { baseHalfLifeDays: 7, ...options });

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-consolidate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Decay pass', () => {
  it('removes entries below the strength threshold (dormant opted out)', async () => {
    initStore(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ dormant: { enabled: false } }), 'utf8');

    // Create an entry that's very old (strength will be effectively 0)
    const entry = createMemory7('ancient memory');
    const veryOldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 * 10).toISOString(); // 10 years
    const ancient = { ...entry, last_retrieved: veryOldDate, pinned: false };
    writeEntry(tmpDir, ancient);

    const result = await consolidate(tmpDir, { now: new Date() });
    expect(result.removed).toBeGreaterThan(0);

    const remaining = loadAllEntries(tmpDir);
    expect(remaining.find((e) => e.id === ancient.id)).toBeUndefined();
  });

  it('keeps pinned entries regardless of age', async () => {
    initStore(tmpDir);

    const entry = createMemory7('permanent rule', { pinned: true });
    const veryOldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 * 10).toISOString();
    const ancient = { ...entry, last_retrieved: veryOldDate, pinned: true };
    writeEntry(tmpDir, ancient);

    await consolidate(tmpDir, { now: new Date() });

    const remaining = loadAllEntries(tmpDir);
    const found = remaining.find((e) => e.id === ancient.id);
    expect(found).toBeDefined();
  });

  it('dry-run does not remove entries', async () => {
    initStore(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ dormant: { enabled: false } }), 'utf8');

    const entry = createMemory7('ancient memory');
    const veryOldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 * 10).toISOString();
    const ancient = { ...entry, last_retrieved: veryOldDate, pinned: false };
    writeEntry(tmpDir, ancient);

    const result = await consolidate(tmpDir, { dryRun: true, now: new Date() });
    expect(result.dryRun).toBe(true);
    expect(result.removed).toBeGreaterThan(0);

    // Entry should still be on disk
    const remaining = loadAllEntries(tmpDir);
    expect(remaining.find((e) => e.id === ancient.id)).toBeDefined();
  });

  it('a dry run reports the same counts and detail lines the real run then produces', async () => {
    initStore(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
    const now = new Date('2026-06-01T00:00:00.000Z');
    const at = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const faded = { half_life_days: 1, created: at, last_retrieved: at };
    writeEntry(tmpDir, { ...createMemory7('an old note about a retired staging hostname nobody uses'), ...faded });
    writeEntry(tmpDir, { ...createMemory7('an old note about rotating the staging deploy key', { tags: ['credential'] }), ...faded });
    writeEntry(tmpDir, createMemory7('cache refresh failure data pipeline error', { layer: Layer.Episodic }));
    writeEntry(tmpDir, createMemory7('cache refresh failure data pipeline problem', { layer: Layer.Episodic }));

    const dry = await consolidate(tmpDir, { dryRun: true, now });
    const real = await consolidate(tmpDir, { now });

    expect(dry.dryRun).toBe(true);
    expect([dry.decayed, dry.dormant, dry.removed, dry.merged]).toEqual([real.decayed, real.dormant, real.removed, real.merged]);
    expect(real.dormant).toBe(1);
    expect(real.removed).toBe(1);
    expect(real.merged).toBe(2);
    expect(dry.details).toEqual(real.details);
    expect(real.details.filter((l) => l.includes('💤') || l.includes('🗑'))).toHaveLength(2);
  });

  it('keeps the stored confidence tier for old non-verified memories through sleep, while resolveConfidence reports stale', async () => {
    initStore(tmpDir);

    const entry = createMemory7('stale memory candidate', { confidence: 'observed', tags: ['error'] });
    const now = new Date();
    const oldDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const staleCandidate = { ...entry, last_retrieved: oldDate, confidence: 'observed' as const };
    writeEntry(tmpDir, staleCandidate);

    await consolidate(tmpDir, { now });

    const loaded = readEntry(tmpDir, staleCandidate.id);
    expect(loaded).not.toBeNull();
    // Confidence is an epistemic tier, not a cached computation (reverses
    // the confidence half of P2-1; strength refresh is untouched).
    expect(loaded!.confidence).toBe('observed');
    expect(resolveConfidence(loaded!, now)).toBe('stale');
  });
});

describe('Replay pass (integration)', () => {
  it('persists incremented retrieval_count and fresh last_retrieved on rehearsed memories', async () => {
    initStore(tmpDir);

    // 8 distinct memories, no text overlap → merge pass won't fire.
    const memories = [
      createMemory7('elephants have long memories according to field study', { layer: Layer.Episodic }),
      createMemory7('production pipeline deploys every friday at noon UTC', { layer: Layer.Episodic }),
      createMemory7('ravens can use tools and solve multi-step puzzles', { layer: Layer.Episodic }),
      createMemory7('rust borrow checker prevents iterator invalidation bugs', { layer: Layer.Episodic }),
      createMemory7('soybean oil futures ticker is ZL=F on yahoo finance', { layer: Layer.Episodic }),
      createMemory7('quantum error correction requires logical qubit overhead', { layer: Layer.Episodic }),
      createMemory7('the postgres vacuum process reclaims dead tuple space', { layer: Layer.Episodic }),
      createMemory7('marine otters wrap kelp around themselves while sleeping', { layer: Layer.Episodic }),
    ];
    for (const m of memories) writeEntry(tmpDir, m);

    const result = await consolidate(tmpDir, { now: new Date() });

    // Default config replay count is 5
    expect(result.replayed).toBe(5);

    // Load all entries and check: exactly 5 should have retrieval_count > 0
    // (only replay bumps retrieval_count during consolidate)
    const after = loadAllEntries(tmpDir);
    const rehearsed = after.filter((e) => e.retrieval_count > 0);
    expect(rehearsed).toHaveLength(5);

    // Each rehearsed entry must have:
    // - retrieval_count = 1 (started at 0)
    // - last_retrieved updated to a recent timestamp
    // - half_life_days bumped by +2 from the default
    const defaultHalfLife = memories[0].half_life_days;
    const recentThreshold = new Date(Date.now() - 60_000).getTime();
    for (const r of rehearsed) {
      expect(r.retrieval_count).toBe(1);
      expect(new Date(r.last_retrieved).getTime()).toBeGreaterThan(recentThreshold);
      expect(r.half_life_days).toBe(defaultHalfLife + 2);
    }
  });

  it('does nothing when config.replay.count is 0', async () => {
    initStore(tmpDir);

    // Patch config.json to disable replay
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ replay: { count: 0 } }, null, 2));

    const memories = [
      createMemory7('memory one with enough content to pass validation', { layer: Layer.Episodic }),
      createMemory7('memory two also sufficiently long to store properly', { layer: Layer.Episodic }),
    ];
    for (const m of memories) writeEntry(tmpDir, m);

    const result = await consolidate(tmpDir, { now: new Date() });

    expect(result.replayed).toBe(0);
    const after = loadAllEntries(tmpDir);
    const touched = after.filter((e) => e.retrieval_count > 0);
    expect(touched).toHaveLength(0);
  });

  it('caps sample size when fewer survivors exist than config count', async () => {
    initStore(tmpDir);

    // Default config count is 5; write only 2 entries.
    const memories = [
      createMemory7('first unique memory for cap test scenario', { layer: Layer.Episodic }),
      createMemory7('second unique memory for cap test scenario', { layer: Layer.Episodic }),
    ];
    for (const m of memories) writeEntry(tmpDir, m);

    const result = await consolidate(tmpDir, { now: new Date() });

    expect(result.replayed).toBe(2);
    expect(result.details.some((l) => /^ {2}💭 replayed 2 memories: /.test(l))).toBe(true);
    const after = loadAllEntries(tmpDir);
    const touched = after.filter((e) => e.retrieval_count > 0);
    expect(touched).toHaveLength(2);
  });
});

describe('Merge pass', () => {
  it('merges highly similar episodic entries into a semantic memory', async () => {
    initStore(tmpDir);

    // Two very similar episodic entries
    const e1 = createMemory7('cache refresh failure data pipeline error', { layer: Layer.Episodic });
    const e2 = createMemory7('cache refresh failure data pipeline problem', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    const result = await consolidate(tmpDir, { now: new Date() });

    expect(result.merged).toBeGreaterThan(0);
    expect(result.semanticCreated).toBeGreaterThan(0);
    expect(result.details.some((l) => l.startsWith('  🔀 merged 2 episodic entries into semantic: '))).toBe(true);

    const all = loadAllEntries(tmpDir);
    const semantics = all.filter((e) => e.layer === Layer.Semantic);
    expect(semantics.length).toBeGreaterThan(0);
  });

  it('does not merge dissimilar entries', async () => {
    initStore(tmpDir);

    const e1 = createMemory7('Python dict ordering is guaranteed since 3.7', { layer: Layer.Episodic });
    const e2 = createMemory7('Gold model uses TIPS 10y inflation signal', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    const result = await consolidate(tmpDir, { now: new Date() });
    expect(result.merged).toBe(0);
    expect(result.semanticCreated).toBe(0);
  });

  it('demotes merged source episodics via half_life_days, not the inert stored-strength field', async () => {
    initStore(tmpDir);

    const e1 = createMemory7('cache refresh failure data pipeline error', { layer: Layer.Episodic });
    const e2 = createMemory7('cache refresh failure data pipeline problem', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    const now = new Date();
    const result = await consolidate(tmpDir, { now });
    expect(result.merged).toBe(2);

    const m1 = readEntry(tmpDir, e1.id);
    const m2 = readEntry(tmpDir, e2.id);
    expect(m1!.half_life_days).toBe(Math.max(1, Math.floor(e1.half_life_days * 0.3)));
    expect(m2!.half_life_days).toBe(Math.max(1, Math.floor(e2.half_life_days * 0.3)));

    // Stored strength is a cache of the LIVE value, not a fake 0.3: fresh
    // entries keep ~full strength now (no immediate ranking cliff)...
    expect(m1!.strength).toBeGreaterThan(0.9);

    // ...but the demotion is real where ranking actually reads it: a few
    // days out, the merged source decays below an unmerged peer written at
    // the same time with the same default half-life.
    const later = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const unmergedPeer = { ...createMemory('completely unrelated standalone topic', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), half_life_days: e1.half_life_days };
    expect(calculateStrength(m1!, later)).toBeLessThan(calculateStrength(unmergedPeer, later));
  });

  it('half-life demotion floors at 1 day', async () => {
    initStore(tmpDir);

    const e1 = { ...createMemory('cache refresh failure data pipeline error', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic }), half_life_days: 2 };
    const e2 = { ...createMemory('cache refresh failure data pipeline problem', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Episodic }), half_life_days: 2 };
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    await consolidate(tmpDir, { now: new Date() });

    expect(readEntry(tmpDir, e1.id)!.half_life_days).toBe(1);
    expect(readEntry(tmpDir, e2.id)!.half_life_days).toBe(1);
  });

  it('detects overlapping contradictory memories and records open conflicts', async () => {
    initStore(tmpDir);

    const a = createMemory7('The feature flag is enabled for production users', {
      layer: Layer.Episodic,
      tags: ['feature-flag', 'prod'],
    });
    const b = createMemory7('The feature flag is disabled for production users', {
      layer: Layer.Episodic,
      tags: ['feature-flag', 'prod'],
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);

    const result = await consolidate(tmpDir, { now: new Date() });

    expect(result.details).toContain('  ⚠️ detected 1 memory conflict');
    const conflicts = listMemoryConflicts(tmpDir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toMatch(/enabled\/disabled mismatch|negation polarity mismatch/i);

    const loadedA = readEntry(tmpDir, a.id);
    const loadedB = readEntry(tmpDir, b.id);
    expect(loadedA?.conflicts_with).toContain(b.id);
    expect(loadedB?.conflicts_with).toContain(a.id);
  });

  it('detects reworded contradictions, not just near-duplicate wording', async () => {
    initStore(tmpDir);

    const a = createMemory7('API auth must be enabled in prod', {
      layer: Layer.Episodic,
      tags: ['auth', 'prod'],
    });
    const b = createMemory7('Disable API auth in prod', {
      layer: Layer.Episodic,
      tags: ['auth', 'prod'],
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);

    await consolidate(tmpDir, { now: new Date() });

    const conflicts = listMemoryConflicts(tmpDir);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toMatch(/enabled\/disabled mismatch|always\/never mismatch|negation polarity mismatch/i);
  });

  it('preserves contradiction detection across multiple polarity patterns', async () => {
    initStore(tmpDir);

    const pairs = [
      [
        'Always use Sled for local storage',
        'Never use Sled for local storage',
      ],
      [
        'API auth must be enabled in prod',
        'Disable API auth in prod',
      ],
      [
        'Production deploys must require approval',
        'Production deploys should not require approval',
      ],
      [
        'Metrics endpoint is available in staging',
        'Metrics endpoint is missing in staging',
      ],
      [
        'Background sync works on iOS',
        'Background sync is broken on iOS',
      ],
    ] as const;

    for (const [left, right] of pairs) {
      const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-consolidate-case-'));
      try {
        initStore(caseDir);

        const a = createMemory7(left, { layer: Layer.Episodic, tags: ['conflict-check'] });
        const b = createMemory7(right, { layer: Layer.Episodic, tags: ['conflict-check'] });
        writeEntry(caseDir, a);
        writeEntry(caseDir, b);

        await consolidate(caseDir, { now: new Date() });

        const conflicts = listMemoryConflicts(caseDir);
        expect(conflicts, `${left} <> ${right}`).toHaveLength(1);
      } finally {
        fs.rmSync(caseDir, { recursive: true, force: true });
      }
    }
  });

  it('does not flag unrelated policy memories just because they share tags and opposite polarity words', async () => {
    initStore(tmpDir);

    const a = createMemory7('Always create a worktree when working in exemem-workspace', {
      layer: Layer.Episodic,
      tags: ['feedback', 'policy'],
    });
    const b = createMemory7('Never touch other agents worktrees', {
      layer: Layer.Episodic,
      tags: ['feedback', 'policy'],
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);

    await consolidate(tmpDir, { now: new Date() });

    expect(listMemoryConflicts(tmpDir)).toHaveLength(0);
    expect(readEntry(tmpDir, a.id)?.conflicts_with ?? []).toEqual([]);
    expect(readEntry(tmpDir, b.id)?.conflicts_with ?? []).toEqual([]);
  });

  it('does not flag the unrelated wording pairs reported in PR #11', async () => {
    initStore(tmpDir);

    const pairs = [
      [
        'Always create a worktree when working in exemem-workspace',
        "Don't touch other agents' worktrees",
      ],
      [
        'Schema service owns schema creation',
        'Schemas are global',
      ],
      [
        'Multi-node dogfood snapshots',
        'Dogfood database snapshot',
      ],
    ] as const;

    const ids = pairs.flatMap(([left, right], index) => {
      const leftEntry = createMemory7(left, {
        layer: Layer.Episodic,
        tags: [`pair-${index}`, 'feedback', 'policy'],
      });
      const rightEntry = createMemory7(right, {
        layer: Layer.Episodic,
        tags: [`pair-${index}`, 'feedback', 'policy'],
      });
      writeEntry(tmpDir, leftEntry);
      writeEntry(tmpDir, rightEntry);
      return [leftEntry.id, rightEntry.id];
    });

    await consolidate(tmpDir, { now: new Date() });

    expect(listMemoryConflicts(tmpDir)).toHaveLength(0);
    for (const id of ids) {
      expect(readEntry(tmpDir, id)?.conflicts_with ?? []).toEqual([]);
    }
  });

  it('resolves open conflicts when the contradiction disappears', async () => {
    initStore(tmpDir);

    const a = createMemory7('The feature flag is enabled for production users', {
      layer: Layer.Episodic,
      tags: ['feature-flag', 'prod'],
    });
    const b = createMemory7('The feature flag is disabled for production users', {
      layer: Layer.Episodic,
      tags: ['feature-flag', 'prod'],
    });
    writeEntry(tmpDir, a);
    writeEntry(tmpDir, b);

    await consolidate(tmpDir, { now: new Date() });
    expect(listMemoryConflicts(tmpDir)).toHaveLength(1);

    writeEntry(tmpDir, { ...b, content: 'The feature flag is enabled for production users' });
    await consolidate(tmpDir, { now: new Date() });

    expect(listMemoryConflicts(tmpDir)).toHaveLength(0);
    expect(readEntry(tmpDir, a.id)?.conflicts_with ?? []).toEqual([]);
    expect(readEntry(tmpDir, b.id)?.conflicts_with ?? []).toEqual([]);
  });
});

describe('Physics pass', () => {
  const STALE = { mass: 99, charge: 0.9, temperature: 0.123, lastSimulation: '2000-01-01T00:00:00.000Z' };

  function storedParticles(): PhysicsParticle[] {
    const db = openHippoDb(tmpDir);
    try {
      return Array.from(loadPhysicsState(db).values());
    } finally {
      closeHippoDb(db);
    }
  }

  /** Three memories, two of them in conflict, each with a particle whose mass, charge and temperature are out of date. */
  function seedConflictingParticles(physicsEnabled: boolean) {
    initStore(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ replay: { count: 0 }, physics: { enabled: physicsEnabled } }), 'utf8');
    // A 30-day half-life, so a pass that lost the half-lives and fell back to the simulation's own default would show.
    const a = createMemory('The deploy job runs on the staging cluster every night', { layer: Layer.Episodic, baseHalfLifeDays: 30 });
    const b = createMemory('Invoices are sent by the billing worker on the first of the month', { layer: Layer.Episodic, baseHalfLifeDays: 30 });
    const c = createMemory('The search index is rebuilt after each schema change', { layer: Layer.Episodic, baseHalfLifeDays: 30 });
    writeEntry(tmpDir, { ...a, conflicts_with: [b.id] });
    writeEntry(tmpDir, { ...b, conflicts_with: [a.id] });
    writeEntry(tmpDir, c);
    const db = openHippoDb(tmpDir);
    try {
      savePhysicsState(db, [
        { ...STALE, memoryId: a.id, position: [1, 0, 0, 0], velocity: [0, 0.02, 0, 0] },
        { ...STALE, memoryId: b.id, position: [0.6, 0.8, 0, 0], velocity: [0, 0, 0, 0] },
        { ...STALE, memoryId: c.id, position: [0, 0.6, 0.8, 0], velocity: [0.01, 0, 0, 0] },
      ]);
    } finally {
      closeHippoDb(db);
    }
    return { a: a.id, b: b.id, c: c.id };
  }

  const cosine = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i], 0);

  it('refreshes each stored particle from its memory, moves it under the survivors conflicts and half-lives, and stores the result', async () => {
    const ids = seedConflictingParticles(true);
    const now = new Date();
    const seeded = storedParticles();
    const entries = loadAllEntries(tmpDir);
    expect(entries.find((e) => e.id === ids.a)?.conflicts_with).toEqual([ids.b]);
    expect(entries.map((e) => e.half_life_days)).toEqual([30, 30, 30]);

    // The same steps the pass must take, on the same particles in the same order.
    const expected = seeded.map((p) => ({ ...p, position: [...p.position], velocity: [...p.velocity] }));
    refreshParticleProperties(expected, new Map(entries.map((e) => [e.id, e])), now);
    const stats = simulate(expected, {
      conflictPairs: new Map(entries.filter((e) => e.conflicts_with.length > 0).map((e) => [e.id, new Set(e.conflicts_with)])),
      halfLives: new Map(entries.map((e) => [e.id, e.half_life_days])),
      config: loadConfig(tmpDir).physics,
    });

    const result = await consolidate(tmpDir, { now });

    expect(result.physicsSimulated).toBe(3);
    expect(result.details).toContain(
      `  ⚛️  physics: 3 particles, avg vel ${stats.avgVelocityMagnitude.toFixed(4)}, energy ${stats.energy.total.toFixed(4)}`,
    );
    const stored = new Map(storedParticles().map((p) => [p.memoryId, p]));
    for (const want of expected) {
      const got = stored.get(want.memoryId)!;
      expect(got.position).toEqual(want.position.map(Math.fround));
      expect(got.velocity).toEqual(want.velocity.map(Math.fround));
      expect({ mass: got.mass, charge: got.charge, temperature: got.temperature })
        .toEqual({ mass: want.mass, charge: want.charge, temperature: want.temperature });
      expect(got.lastSimulation).not.toBe(STALE.lastSimulation);
    }

    // The stale properties are gone, and the conflicting pair ends further apart than it started.
    const [a, b] = [stored.get(ids.a)!, stored.get(ids.b)!];
    expect(a.mass).toBeLessThan(2);
    expect(a.charge).toBe(0);
    expect(cosine(a.position, b.position)).toBeLessThan(0.6);
  });

  it('leaves the stored particles alone on a dry run', async () => {
    seedConflictingParticles(true);
    const seeded = storedParticles();

    const result = await consolidate(tmpDir, { now: new Date(), dryRun: true });

    expect(result.physicsSimulated).toBe(0);
    expect(storedParticles()).toEqual(seeded);
  });

  it('leaves the stored particles alone when physics is off, and reports nothing when none is stored', async () => {
    seedConflictingParticles(false);
    const seeded = storedParticles();
    const off = await consolidate(tmpDir, { now: new Date() });
    expect(off.physicsSimulated).toBe(0);
    expect(storedParticles()).toEqual(seeded);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-consolidate-nophysics-'));
    try {
      initStore(empty);
      fs.writeFileSync(path.join(empty, 'config.json'), JSON.stringify({ physics: { enabled: true } }), 'utf8');
      writeEntry(empty, createMemory7('A memory with no particle stored for it'));
      const result = await consolidate(empty, { now: new Date() });
      expect(result.physicsSimulated).toBe(0);
      expect(result.details.filter((line) => line.includes('physics'))).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
