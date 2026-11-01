// The learn route waits for its lesson embeds when the Context has no keeper, and hands them to
// the root's keeper when it has one, so the command runtime settles them.
import { describe, expect, it } from 'vitest';
import { CLI_LEARN, learn, type LearnOptions } from '../../src/api/index.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import type { GitRunner } from '../../src/base/ports/git.js';
import { DetachedSet } from '../../src/base/util/detached-set.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { testInfra } from '../_helpers/infra.js';
import { makeRoot } from '../_helpers/make-root.js';

const LESSON = 'fix: the retry loop dropped the last queued webhook delivery';
const git: GitRunner = { run: (args) => ({ ok: true, stdout: args[0] === 'rev-parse' ? 'true\n' : LESSON }) };
const OPTS: LearnOptions = { repoPath: '/repo', days: 30, profile: CLI_LEARN, git };

/** An embedder whose vectors wait for `release`; `started` resolves once a lesson reaches it. */
function heldEmbedder() {
  const embedded: string[] = [];
  let release = (): void => {};
  let start = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (start = resolve));
  const provider: EmbeddingProvider = {
    kind: 'local',
    model: 'held',
    id: 'held',
    isAvailable: () => true,
    embed: async (texts) => {
      start();
      await held;
      embedded.push(...texts);
      return texts.map(() => [1, 0, 0]);
    },
  };
  return { provider, embedded, started, release: () => release() };
}

function learnCtx(name: string, provider: EmbeddingProvider): FullContext {
  return { ...apiCtx(makeRoot(name)), infra: { ...testInfra(), embedderFor: () => provider } };
}

describe('learn embeds the lessons it lands', () => {
  it('waits for the embeds when the Context has no keeper', async () => {
    const embedder = heldEmbedder();
    let returned = false;
    const run = learn(learnCtx('learn-embed-own', embedder.provider), OPTS).finally(() => {
      returned = true;
    });
    await embedder.started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    embedder.release();
    expect((await run).added).toBe(1);
    expect(embedder.embedded).toHaveLength(1);
  });

  it("hands the embeds to the root's keeper when the Context has one", async () => {
    const embedder = heldEmbedder();
    const keeper = new DetachedSet();
    const ctx = { ...learnCtx('learn-embed-keeper', embedder.provider), detached: keeper };
    expect((await learn(ctx, OPTS)).added).toBe(1);
    expect(embedder.embedded).toEqual([]);
    expect(await keeper.settle(0)).toBe(1);
    embedder.release();
    await keeper.settle();
    expect(embedder.embedded).toHaveLength(1);
  });
});
