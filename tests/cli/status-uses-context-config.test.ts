// The status parts print from the config and embedder on the context they are given, not from a
// fresh read of the folder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleStatus, physicsEnergyText } from '../../src/surface/cli/status.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { HippoConfig } from '../../src/base/config/config.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { endLastingCommands, lastingCommand } from '../_helpers/test-cli.js';

afterEach(() => {
  endLastingCommands();
  vi.restoreAllMocks();
});

describe('status', () => {
  it('takes the embedder and its enabled flag from the context', async () => {
    const root = makeRoot('status-ctx-embed');
    const base = lastingCommand().apiContext(root, 'default');
    const asked: HippoConfig['embeddings'][] = [];
    const provider = {
      kind: 'local',
      model: 'stub',
      id: 'stub',
      isAvailable: () => true,
      embed: async () => [],
    } satisfies EmbeddingProvider;
    const ctx = {
      ...base,
      config: { ...base.config, embeddings: { ...base.config.embeddings, enabled: false } },
      infra: {
        ...base.infra,
        embedderFor: (cfg: HippoConfig['embeddings']) => {
          asked.push(cfg);
          return provider;
        },
      },
    };
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleStatus({
      cli: { ...lastingCommand(), apiContext: () => ctx },
      hippoRoot: root,
      tenantId: 'default',
      args: [],
      flags: {},
    });
    const lines = out.mock.calls.map((c) => String(c[0]));
    expect(asked).toEqual([ctx.config.embeddings]);
    expect(lines.some((l) => l.includes('disabled in config'))).toBe(true);
  });

  it('prints physics energy with the gravity the context carries', async () => {
    const root = makeRoot('status-ctx-physics');
    const entries = [createMemory('particle a'), createMemory('particle b')];
    writeEntriesTogether(root, entries);
    const saved: PhysicsParticle[] = entries.map((e, i) => ({
      memoryId: e.id,
      position: [1, 0],
      velocity: [i * 0.5, 0.25],
      mass: 1,
      charge: 0,
      temperature: 1,
      lastSimulation: '2026-01-01T00:00:00.000Z',
    }));
    await sqliteStore(root).consolidation.saveParticles(saved);
    const base = lastingCommand().apiContext(root, 'default');
    const gMemory = base.config.physics.gMemory + 7;
    const ctx = { ...base, config: { ...base.config, physics: { ...base.config.physics, gMemory } } };
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleStatus({
      cli: { ...lastingCommand(), apiContext: () => ctx },
      hippoRoot: root,
      tenantId: 'default',
      args: [],
      flags: {},
    });
    const line = out.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('Physics:'));
    expect(line).toContain(physicsEnergyText({ count: 2, particles: saved }, gMemory));
  });
});
