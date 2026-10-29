// The status embedding line prints from the config and embedder on the context it is given, not
// from a fresh read of the folder.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleStatus } from '../../src/surface/cli/status.js';
import { cliApiContext } from '../../src/surface/cli/api-context.js';
import type { HippoConfig } from '../../src/base/config/config.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => vi.restoreAllMocks());

describe('status', () => {
  it('takes the embedder and its enabled flag from the context', async () => {
    const root = makeRoot('status-ctx-embed');
    const base = cliApiContext(root, 'default');
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
    await handleStatus({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }, ctx);
    const lines = out.mock.calls.map((c) => String(c[0]));
    expect(asked).toEqual([ctx.config.embeddings]);
    expect(lines.some((l) => l.includes('disabled in config'))).toBe(true);
  });
});
